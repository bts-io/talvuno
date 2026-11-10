import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MENU_DIGITS,
  MENU_KEYS_MAX,
  MENU_PROMPT_MAX,
  type MenuAction,
  type MenuDefaultAction,
  type MenuKey,
  type NumberMenu,
  numberMenuInputSchema,
} from "../../../contracts/menus";
import { formatPhone } from "../../../lib/phone";
import { menusQuery, previewMenu, saveNumberMenu } from "../../hooks/use-routing";
import { numbersQuery } from "../../hooks/use-settings";
import { buttonClass, ErrorLine, inputClass, primaryButtonClass, Section } from "./section";

type KeyDraft = { digit: string; action: MenuAction; to: string };

const toDraft = (k: MenuKey): KeyDraft => ({
  digit: k.digit,
  action: k.action,
  to: k.action === "forward" ? k.to : "",
});

const fromDraft = (k: KeyDraft): MenuKey =>
  k.action === "forward"
    ? { digit: k.digit as MenuKey["digit"], action: "forward", to: k.to.replace(/[\s()-]/g, "") }
    : { digit: k.digit as MenuKey["digit"], action: k.action };

/** The phone menu of each number: a spoken message and keys that ring, go to voicemail or forward. */
export function MenuSection() {
  const { t } = useTranslation();
  const { data: menus } = useQuery(menusQuery());
  const { data: numbers } = useQuery(numbersQuery());
  return (
    <Section id="menu" title={t("routing.menu.title")} intro={t("routing.menu.intro")}>
      {menus && !menus.length ? <p className="text-sm text-slate-500">{t("routing.noNumbers")}</p> : null}
      {menus?.map((m) => {
        const n = numbers?.find((x) => x.id === m.numberId);
        return (
          <NumberMenuForm key={m.numberId} menu={m} label={n?.friendlyName || formatPhone(n?.e164 ?? "")} />
        );
      })}
    </Section>
  );
}

function NumberMenuForm({ menu, label }: { menu: NumberMenu; label: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(menu.enabled);
  const [prompt, setPrompt] = useState(menu.prompt);
  const [keys, setKeys] = useState<KeyDraft[]>(() => menu.keys.map(toDraft));
  const [defaultAction, setDefaultAction] = useState<MenuDefaultAction>(menu.defaultAction);
  const save = useMutation({
    mutationFn: () =>
      saveNumberMenu(menu.numberId, { enabled, prompt, keys: keys.map(fromDraft), defaultAction }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routing", "menus"] }),
  });
  const preview = useMutation({ mutationFn: () => previewMenu(prompt) });

  const draft = { enabled, prompt, keys: keys.map(fromDraft), defaultAction };
  const valid = numberMenuInputSchema.safeParse(draft).success;
  const missing = enabled && (!prompt.trim() || !keys.length);
  const free = MENU_DIGITS.filter((d) => !keys.some((k) => k.digit === d));
  const setKey = (i: number, p: Partial<KeyDraft>) =>
    setKeys((all) => all.map((k, j) => (j === i ? { ...k, ...p } : k)));

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-navy-800">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("routing.menu.enabled")}
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("routing.menu.prompt")}
        <textarea
          value={prompt}
          maxLength={MENU_PROMPT_MAX}
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
          className={inputClass}
        />
        <span className="font-normal text-slate-500">{t("routing.menu.promptHint")}</span>
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("routing.menu.keys")}</span>
        {!keys.length ? <p className="text-sm text-slate-500">{t("routing.menu.noKeys")}</p> : null}
        <ul className="flex flex-col gap-2">
          {keys.map((k, i) => (
            <li key={k.digit} className="flex flex-wrap items-end gap-2 text-sm">
              <label className="flex flex-col gap-1">
                {t("routing.menu.key")}
                <select
                  value={k.digit}
                  onChange={(e) => setKey(i, { digit: e.target.value })}
                  className={`${inputClass} w-20`}
                >
                  {[k.digit, ...free].sort().map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                {t("routing.menu.action")}
                <select
                  value={k.action}
                  onChange={(e) => setKey(i, { action: e.target.value as MenuAction })}
                  className={`${inputClass} w-52`}
                >
                  {(["ring", "voicemail", "forward"] as const).map((a) => (
                    <option key={a} value={a}>
                      {t(`routing.menu.actions.${a}`)}
                    </option>
                  ))}
                </select>
              </label>
              {k.action === "forward" ? (
                <label className="flex flex-col gap-1">
                  {t("routing.menu.forwardTo")}
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    value={k.to}
                    onChange={(e) => setKey(i, { to: e.target.value })}
                    className={`${inputClass} w-44`}
                  />
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => setKeys((all) => all.filter((_, j) => j !== i))}
                className={buttonClass}
              >
                {t("routing.menu.removeKey", { digit: k.digit })}
              </button>
            </li>
          ))}
        </ul>
        {keys.some((k) => k.action === "forward") ? (
          <p className="text-sm text-slate-500">{t("routing.menu.forwardHint")}</p>
        ) : null}
        {keys.length < MENU_KEYS_MAX && free.length ? (
          <div>
            <button
              type="button"
              onClick={() => setKeys((all) => [...all, { digit: free[0]!, action: "ring", to: "" }])}
              className={buttonClass}
            >
              {t("routing.menu.addKey")}
            </button>
          </div>
        ) : null}
      </div>

      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("routing.menu.defaultAction")}
        <select
          value={defaultAction}
          onChange={(e) => setDefaultAction(e.target.value as MenuDefaultAction)}
          className={`${inputClass} w-52`}
        >
          {(["ring", "voicemail"] as const).map((a) => (
            <option key={a} value={a}>
              {t(`routing.menu.actions.${a}`)}
            </option>
          ))}
        </select>
        <span className="font-normal text-slate-500">{t("routing.menu.defaultHint")}</span>
      </label>

      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("routing.menu.test")}</span>
        <span className="text-slate-500">{t("routing.menu.testHint")}</span>
        <div>
          <button
            type="button"
            disabled={!prompt.trim() || preview.isPending}
            onClick={() => preview.mutate()}
            className={buttonClass}
          >
            {t("routing.menu.testButton")}
          </button>
        </div>
        {preview.data ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-100 p-2 text-xs dark:bg-navy-950">
            {preview.data.twiml}
          </pre>
        ) : null}
        <ErrorLine error={preview.error} />
      </div>

      {missing ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("routing.menu.needsPromptAndKey")}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!valid || save.isPending}
          onClick={() => save.mutate()}
          className={primaryButtonClass}
        >
          {t("routing.save")}
        </button>
        {save.isSuccess ? <span className="text-sm text-slate-500">{t("routing.saved")}</span> : null}
      </div>
      <ErrorLine error={save.error} />
    </fieldset>
  );
}
