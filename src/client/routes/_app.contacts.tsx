import {
  ChatCircleText,
  DownloadSimple,
  MagnifyingGlass,
  Phone,
  Plus,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import type { Contact } from "../../contracts";
import type { ContactList, VcardImportResult } from "../../contracts/contacts";
import { formatPhone } from "../../lib/phone";
import { BlockButton } from "../components/block-button";
import { ApiError, api } from "../lib/api";

export const Route = createFileRoute("/_app/contacts")({
  // `add` opens the new-contact sheet with this number filled in (Recents links here for unknown callers).
  validateSearch: z.object({ add: z.string().max(40).optional() }),
  component: ContactsPage,
});

const LABELS = ["mobile", "home", "work", "main", "fax", "other"] as const;
const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base dark:border-navy-700 dark:bg-navy-950";
const primaryButton =
  "rounded-lg bg-brand-blue px-4 py-2.5 font-medium text-white hover:bg-brand-blue-strong disabled:opacity-60";

type Draft = {
  id: string | null;
  displayName: string;
  company: string;
  notes: string;
  numbers: DraftNumber[];
};
type DraftNumber = { key: number; number: string; label: string };

let nextKey = 1;
const blankNumber = (number = ""): DraftNumber => ({ key: nextKey++, number, label: "mobile" });

const draftFrom = (c: Contact | null, number?: string): Draft =>
  c
    ? {
        id: c.id,
        displayName: c.displayName,
        company: c.company ?? "",
        notes: c.notes ?? "",
        numbers: c.numbers.map((n) => ({ key: nextKey++, number: n.e164, label: n.label ?? "" })),
      }
    : { id: null, displayName: "", company: "", notes: "", numbers: [blankNumber(number)] };

function ContactsPage() {
  const { t } = useTranslation();
  const { add } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState<Draft | null>(() => (add ? draftFrom(null, add) : null));
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Leave the sheet's `add` hint out of the address once it has been used.
  useEffect(() => {
    if (add) navigate({ href: "/contacts", replace: true });
  }, [add, navigate]);

  const query = useInfiniteQuery({
    queryKey: ["contacts", q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (pageParam) params.set("cursor", pageParam);
      return api<ContactList>(`/api/contacts?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const importFile = useMutation({
    mutationFn: (file: File) =>
      api<VcardImportResult>("/api/contacts/import", {
        method: "POST",
        body: file,
        headers: { "content-type": "text/vcard" },
      }),
    onSuccess: (r) => {
      setNotice({ text: t("contacts.importDone", r), error: false });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      // Calls are named from the contact book, so history may now show new names.
      qc.invalidateQueries({ queryKey: ["calls"] });
    },
    onError: (err) =>
      setNotice({ text: t("contacts.importFailed", { message: errorText(err) }), error: true }),
  });

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("contacts.title")}</h1>
        <button
          type="button"
          onClick={() => setDraft(draftFrom(null))}
          className="flex items-center gap-1.5 rounded-lg bg-brand-blue px-3 py-2 text-sm font-medium text-white hover:bg-brand-blue-strong"
        >
          <Plus aria-hidden className="size-4" />
          {t("contacts.add")}
        </button>
      </div>

      <label className="relative block">
        <span className="sr-only">{t("contacts.search")}</span>
        <MagnifyingGlass
          aria-hidden
          className="pointer-events-none absolute inset-y-0 start-3 my-auto size-5 text-slate-400"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("contacts.search")}
          className={`${inputClass} ps-10`}
        />
      </label>

      <div className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={importFile.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-100 disabled:opacity-60 dark:border-navy-700 dark:hover:bg-navy-800"
        >
          <UploadSimple aria-hidden className="size-4" />
          {importFile.isPending ? t("contacts.importing") : t("contacts.import")}
        </button>
        <a
          href="/api/contacts/export"
          download="talvuno-contacts.vcf"
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-navy-700 dark:hover:bg-navy-800"
        >
          <DownloadSimple aria-hidden className="size-4" />
          {t("contacts.export")}
        </a>
        <input
          ref={fileInput}
          type="file"
          accept=".vcf,text/vcard,text/x-vcard"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) importFile.mutate(file);
          }}
        />
      </div>

      {notice ? (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-red-600 dark:text-red-400" : "text-slate-600 dark:text-slate-300"}`}
        >
          {notice.text}
        </p>
      ) : null}

      {query.isError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("contacts.loadFailed")}
        </p>
      ) : query.isPending ? (
        <p className="text-slate-500">{t("contacts.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">{t(q ? "contacts.noMatch" : "contacts.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-navy-800 dark:border-navy-800 dark:bg-navy-900">
          {items.map((c) => (
            <ContactRow key={c.id} contact={c} onEdit={() => setDraft(draftFrom(c))} />
          ))}
        </ul>
      )}

      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="self-center rounded-lg px-4 py-2 text-sm font-medium text-brand-blue hover:bg-brand-blue/10 disabled:opacity-60"
        >
          {query.isFetchingNextPage ? t("contacts.loading") : t("contacts.loadMore")}
        </button>
      ) : null}

      {draft ? <ContactSheet draft={draft} onClose={() => setDraft(null)} /> : null}
    </section>
  );
}

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : String(err);
}

function ContactRow({ contact, onEdit }: { contact: Contact; onEdit: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <button
        type="button"
        onClick={onEdit}
        aria-label={t("contacts.edit", { name: contact.displayName })}
        className="text-start"
      >
        <span className="block truncate font-medium" dir="auto">
          {contact.displayName}
        </span>
        {contact.company ? (
          <span className="block truncate text-sm text-slate-500 dark:text-slate-400" dir="auto">
            {contact.company}
          </span>
        ) : null}
      </button>
      <ul className="flex flex-col">
        {contact.numbers.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm text-slate-600 dark:text-slate-300">
              <bdi>{formatPhone(n.e164)}</bdi>
              {n.label ? (
                <span className="text-slate-400">
                  {" "}
                  {t(`contacts.labels.${n.label}`, { defaultValue: n.label })}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0">
              <button
                type="button"
                aria-label={t("contacts.call", { name: contact.displayName })}
                onClick={() => navigate({ href: `/keypad?to=${encodeURIComponent(n.e164)}` })}
                className="rounded-lg p-2 text-brand-blue hover:bg-brand-blue/10"
              >
                <Phone aria-hidden className="size-5" />
              </button>
              <button
                type="button"
                aria-label={t("contacts.text", { name: contact.displayName })}
                onClick={() => navigate({ href: `/messages/new?to=${encodeURIComponent(n.e164)}` })}
                className="rounded-lg p-2 text-brand-blue hover:bg-brand-blue/10"
              >
                <ChatCircleText aria-hidden className="size-5" />
              </button>
              <BlockButton address={n.e164} />
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function ContactSheet({ draft: initial, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const done = () => {
    qc.invalidateQueries({ queryKey: ["contacts"] });
    qc.invalidateQueries({ queryKey: ["calls"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        displayName: draft.displayName,
        company: draft.company || null,
        notes: draft.notes || null,
        numbers: draft.numbers
          .filter((n) => n.number.trim())
          .map((n) => ({ number: n.number, label: n.label || null })),
      };
      return draft.id
        ? api(`/api/contacts/${draft.id}`, { method: "PUT", json: body })
        : api("/api/contacts", { method: "POST", json: body });
    },
    onSuccess: done,
    onError: (err) => setError(t("contacts.saveFailed", { message: errorText(err) })),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/contacts/${draft.id}`, { method: "DELETE" }),
    onSuccess: done,
    onError: (err) => setError(t("contacts.deleteFailed", { message: errorText(err) })),
  });

  const setNumber = (key: number, patch: Partial<DraftNumber>) =>
    setDraft((d) => ({ ...d, numbers: d.numbers.map((n) => (n.key === key ? { ...n, ...patch } : n)) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50 md:items-center">
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t(draft.id ? "contacts.editTitle" : "contacts.newTitle")}
        onSubmit={submit}
        className="flex max-h-dvh w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl md:rounded-2xl dark:bg-navy-900"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {t(draft.id ? "contacts.editTitle" : "contacts.newTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("contacts.close")}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("contacts.name")}</span>
          <input
            required
            maxLength={200}
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            className={inputClass}
            dir="auto"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("contacts.company")}</span>
          <input
            maxLength={200}
            value={draft.company}
            onChange={(e) => setDraft({ ...draft, company: e.target.value })}
            className={inputClass}
            dir="auto"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("contacts.numbers")}</legend>
          {draft.numbers.map((n) => (
            <div key={n.key} className="flex items-center gap-2">
              <input
                type="tel"
                inputMode="tel"
                autoComplete="off"
                aria-label={t("contacts.number")}
                placeholder="+1 415 555 2671"
                value={n.number}
                onChange={(e) => setNumber(n.key, { number: e.target.value })}
                className={`${inputClass} min-w-0 flex-1`}
                dir="ltr"
              />
              <select
                aria-label={t("contacts.label")}
                value={n.label}
                onChange={(e) => setNumber(n.key, { label: e.target.value })}
                className={`${inputClass} w-auto`}
              >
                <option value="">{t("contacts.labels.none")}</option>
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {t(`contacts.labels.${l}`)}
                  </option>
                ))}
                {n.label && !(LABELS as readonly string[]).includes(n.label) ? (
                  <option value={n.label}>{n.label}</option>
                ) : null}
              </select>
              <button
                type="button"
                aria-label={t("contacts.removeNumber")}
                onClick={() => setDraft((d) => ({ ...d, numbers: d.numbers.filter((x) => x.key !== n.key) }))}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
          ))}
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("contacts.numberHint")}</p>
          {draft.numbers.length < 20 ? (
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, numbers: [...d.numbers, blankNumber()] }))}
              className="flex items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-sm text-brand-blue hover:bg-brand-blue/10"
            >
              <Plus aria-hidden className="size-4" />
              {t("contacts.addNumber")}
            </button>
          ) : null}
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("contacts.notes")}</span>
          <textarea
            rows={3}
            maxLength={4000}
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            className={inputClass}
            dir="auto"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        {confirmDelete ? (
          <div className="flex flex-col gap-2 rounded-lg border border-red-300 p-3 dark:border-red-500/50">
            <p className="text-sm">{t("contacts.deleteConfirm", { name: draft.displayName })}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {remove.isPending ? t("contacts.deleting") : t("contacts.deleteYes")}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-navy-800"
              >
                {t("contacts.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button type="submit" disabled={save.isPending} className={primaryButton}>
              {save.isPending ? t("contacts.saving") : t("contacts.save")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2.5 hover:bg-slate-100 dark:hover:bg-navy-800"
            >
              {t("contacts.cancel")}
            </button>
            {draft.id ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="ms-auto rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
              >
                {t("contacts.delete")}
              </button>
            ) : null}
          </div>
        )}
      </form>
    </div>
  );
}
