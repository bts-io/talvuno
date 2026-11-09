/**
 * SMS length rules shared by the composer and the Worker. A message that fits the GSM-7 alphabet uses 160
 * characters per single segment (153 each when split); anything else is sent as UCS-2 with 70 (67 when
 * split). Characters in the GSM-7 extension table (for example the euro sign and square brackets) take two.
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

const basic = new Set(GSM_BASIC);
const extended = new Set(GSM_EXTENDED);

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsLength = {
  encoding: SmsEncoding;
  /** Characters as the person sees them. */
  characters: number;
  /** Units the carrier counts: septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Units left before the next segment starts. */
  remaining: number;
};

export function smsLength(body: string): SmsLength {
  const chars = [...body];
  let gsm = true;
  let septets = 0;
  for (const ch of chars) {
    if (basic.has(ch)) septets += 1;
    else if (extended.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  const encoding: SmsEncoding = gsm ? "GSM-7" : "UCS-2";
  const units = gsm ? septets : body.length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const capacity = segments <= 1 ? single : segments * multi;
  return { encoding, characters: chars.length, units, segments, remaining: capacity - units };
}
