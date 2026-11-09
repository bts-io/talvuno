import { describe, expect, it } from "vitest";
import { parseVcf, serializeVcf, type VcardContact } from "../../src/lib/vcard";

const card = (...lines: string[]) => ["BEGIN:VCARD", ...lines, "END:VCARD"].join("\r\n");

describe("parseVcf", () => {
  it("reads a 3.0 card with typed numbers", () => {
    const { contacts, skipped } = parseVcf(
      card(
        "VERSION:3.0",
        "FN:Ada Lovelace",
        "N:Lovelace;Ada;;;",
        "ORG:Analytical Engines;Research",
        "TEL;TYPE=CELL,VOICE:+1 (415) 555-2671",
        "TEL;TYPE=WORK:+44 20 7946 0958",
        "NOTE:Met in London\\, 1843\\nCall back",
      ),
    );
    expect(skipped).toBe(0);
    expect(contacts).toEqual([
      {
        displayName: "Ada Lovelace",
        company: "Analytical Engines",
        notes: "Met in London, 1843\nCall back",
        numbers: [
          { number: "+14155552671", label: "mobile" },
          { number: "+442079460958", label: "work" },
        ],
      },
    ]);
  });

  it("reads a 4.0 card with tel: URIs and a group prefix", () => {
    const { contacts } = parseVcf(
      card(
        "VERSION:4.0",
        "FN:Grace Hopper",
        'item1.TEL;VALUE=uri;TYPE="home,voice":tel:+14155552671;ext=12',
        "TEL;VALUE=uri:tel:+1-415-555-2672",
      ),
    );
    expect(contacts[0]?.numbers).toEqual([
      { number: "+14155552671", label: "home" },
      { number: "+14155552672", label: null },
    ]);
  });

  it("falls back to N, then ORG, for the name", () => {
    const { contacts } = parseVcf(
      [card("N:Hopper;Grace;M.;Dr.;", "TEL:+14155552671"), card("ORG:Acme", "TEL:+14155552672")].join("\r\n"),
    );
    expect(contacts.map((c) => c.displayName)).toEqual(["Dr. Grace M. Hopper", "Acme"]);
  });

  it("unfolds long lines and accepts bare LF", () => {
    const text = "BEGIN:VCARD\nFN:A very long\n  name here\nTEL:+14155552671\nEND:VCARD\n";
    expect(parseVcf(text).contacts[0]?.displayName).toBe("A very long name here");
  });

  it("skips cards with no name, no valid number, or an unclosed body, and counts them", () => {
    const text = [
      card("TEL:+14155552671"),
      card("FN:No Number"),
      card("FN:Bad Number", "TEL:12"),
      card("FN:National", "TEL:(415) 555-2671"),
      card("FN:Good", "TEL:+14155552671"),
      "BEGIN:VCARD\r\nFN:Unclosed\r\nTEL:+14155552671",
    ].join("\r\n");
    const { contacts, skipped } = parseVcf(text);
    expect(contacts.map((c) => c.displayName)).toEqual(["Good"]);
    expect(skipped).toBe(5);
  });

  it("reads national numbers when given a default country", () => {
    const { contacts } = parseVcf(card("FN:Local", "TEL:(415) 555-2671"), "US");
    expect(contacts[0]?.numbers[0]?.number).toBe("+14155552671");
  });

  it("keeps a repeated number once", () => {
    const { contacts } = parseVcf(card("FN:Dup", "TEL:+14155552671", "TEL:+1 415 555 2671"));
    expect(contacts[0]?.numbers).toHaveLength(1);
  });

  it("returns nothing for text that is not a vCard", () => {
    expect(parseVcf("hello world")).toEqual({ contacts: [], skipped: 0 });
  });
});

describe("serializeVcf", () => {
  const sample: VcardContact[] = [
    {
      displayName: "Zoë; Smith, Jr.",
      company: "Acme, Inc.",
      notes: "line one\nline two",
      numbers: [
        { number: "+14155552671", label: "mobile" },
        { number: "+442079460958", label: null },
        { number: "+14155552672", label: "fax" },
      ],
    },
  ];

  it("round trips through the parser", () => {
    const out = parseVcf(serializeVcf(sample));
    expect(out.skipped).toBe(0);
    expect(out.contacts).toEqual(sample);
  });

  it("uses CRLF and folds lines to 75 octets", () => {
    const name = "é".repeat(120);
    const text = serializeVcf([
      { displayName: name, company: null, notes: null, numbers: [{ number: "+14155552671", label: null }] },
    ]);
    for (const line of text.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(text.endsWith("\r\n")).toBe(true);
    expect(parseVcf(text).contacts[0]?.displayName).toBe(name.slice(0, 200));
  });
});

describe("parseVcf quoted-printable", () => {
  // Android exports vCard 2.1 like this: encoded UTF-8 bytes and a soft line break inside the name.
  const android = [
    "BEGIN:VCARD",
    "VERSION:2.1",
    "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=C3=89mile;Zo=C3=AB;;;",
    "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Zo=C3=AB =C3=89mi=",
    "le",
    "TEL;CELL:+14155552671",
    "NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9=0Anext",
    "END:VCARD",
  ].join("\r\n");

  it("decodes names, notes and soft line breaks as UTF-8", () => {
    const { contacts, skipped } = parseVcf(android);
    expect(skipped).toBe(0);
    expect(contacts).toEqual([
      {
        displayName: "Zoë Émile",
        company: null,
        notes: "Café\nnext",
        numbers: [{ number: "+14155552671", label: "mobile" }],
      },
    ]);
  });

  it("falls back to N when FN is missing, and honours another CHARSET", () => {
    const text = [
      "BEGIN:VCARD",
      "N;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:=C9mile;Jos=E9;;;",
      "TEL:+14155552671",
      "END:VCARD",
    ].join("\n");
    expect(parseVcf(text).contacts[0]?.displayName).toBe("José Émile");
  });

  it("still skips base64 properties", () => {
    const text = card("FN;ENCODING=b:Wm9l", "TEL:+14155552671");
    expect(parseVcf(text)).toEqual({ contacts: [], skipped: 1 });
  });

  it("stops after maxCards and counts the rest as skipped", () => {
    const text = Array.from({ length: 5 }, (_, i) => card(`FN:P${i}`, `TEL:+1415555260${i}`)).join("\r\n");
    const r = parseVcf(text, undefined, 3);
    expect(r.contacts.map((c) => c.displayName)).toEqual(["P0", "P1", "P2"]);
    expect(r.skipped).toBe(2);
  });
});
