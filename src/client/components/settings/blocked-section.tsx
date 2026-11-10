import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatPhone, isE164, toE164 } from "../../../lib/phone";
import { blockAddress, blockedQuery, unblockAddress } from "../../hooks/use-routing";
import { buttonClass, ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

/** The block list: review, add and remove blocked numbers and senders. */
export function BlockedSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: items } = useQuery(blockedQuery());
  const [draft, setDraft] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["routing", "blocked"] });
  // A typed phone number becomes E.164, so it matches what Twilio sends. Anything else is a sender ID.
  const address = toE164(draft.trim()) ?? draft.trim();
  const add = useMutation({
    mutationFn: () => blockAddress(address),
    onSuccess: () => {
      setDraft("");
      void refresh();
    },
  });
  const remove = useMutation({ mutationFn: unblockAddress, onSettled: refresh });

  return (
    <Section id="blocked" title={t("routing.blocked.title")} intro={t("routing.blocked.intro")}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (address) add.mutate();
        }}
      >
        <label htmlFor="block-number" className="sr-only">
          {t("routing.blocked.add")}
        </label>
        <input
          id="block-number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("routing.blocked.add")}
          className={inputClass}
          autoComplete="off"
        />
        <button type="submit" disabled={!address || add.isPending} className={primaryButtonClass}>
          {t("routing.blocked.block")}
        </button>
      </form>
      <ErrorLine error={add.error ?? remove.error} />
      {items && !items.length ? <p className="text-sm text-slate-500">{t("routing.blocked.empty")}</p> : null}
      {items?.length ? (
        <ul className="divide-y divide-slate-200 dark:divide-navy-800">
          {items.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>{isE164(b.address) ? formatPhone(b.address) : b.address}</span>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(b.address)}
                className={buttonClass}
              >
                {t("routing.blocked.unblock")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
