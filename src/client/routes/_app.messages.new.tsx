import { ArrowLeft, Info } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { formatPhone, toE164 } from "../../lib/phone";
import { SmsComposer } from "../components/sms-composer";
import { failureText, newClientId, smsNumbersQuery, useSendMessage } from "../lib/messages";

/** A new conversation: recipient (prefilled from `?to=`), the number it goes out from, and the composer. */
export const Route = createFileRoute("/_app/messages/new")({
  validateSearch: z.object({ to: z.string().max(64).optional().catch(undefined) }),
  component: NewMessagePage,
});

function NewMessagePage() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const numbers = useQuery(smsNumbersQuery());
  const [to, setTo] = useState(search.to ?? "");
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = useSendMessage();
  const numberId = picked ?? numbers.data?.[0]?.id ?? null;
  const e164 = toE164(to);

  const onSend = async (body: string) => {
    setError(null);
    if (!numberId) return false;
    if (!e164) {
      setError(t("messages.invalidNumber"));
      return false;
    }
    try {
      const result = await send.mutateAsync({ input: { numberId, to: e164, body }, clientId: newClientId() });
      await navigate({ to: "/messages/$conversationId", params: { conversationId: result.conversationId } });
      return true;
    } catch (err) {
      setError(failureText(t, err));
      return false;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 p-3 dark:border-navy-800">
        <Link to="/messages" className="rounded-full p-2 md:hidden" aria-label={t("messages.back")}>
          <ArrowLeft aria-hidden className="size-5 rtl:-scale-x-100" />
        </Link>
        <h1 className="font-semibold">{t("messages.new")}</h1>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <label className="flex items-center gap-3">
          <span className="w-12 text-sm text-slate-500">{t("messages.to")}</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder={t("messages.toPlaceholder")}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900"
          />
        </label>
        {numbers.data && numbers.data.length > 0 ? (
          <label className="flex items-center gap-3">
            <span className="w-12 text-sm text-slate-500">{t("messages.from")}</span>
            <select
              value={numberId ?? ""}
              onChange={(e) => setPicked(e.target.value)}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900"
            >
              {numbers.data.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.friendlyName ? `${n.friendlyName} (${formatPhone(n.e164)})` : formatPhone(n.e164)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          numbers.data && <p className="text-sm text-slate-500">{t("messages.noNumbers")}</p>
        )}
        <p className="flex gap-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-600 dark:bg-navy-900 dark:text-slate-300">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("messages.a2pNote")}
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      <SmsComposer
        draftKey={`new:${search.to ?? ""}`}
        disabled={!numberId || send.isPending}
        onSend={onSend}
      />
    </div>
  );
}
