import type { ReactNode } from "react";

/** An empty tab until its feature lands. */
export function Placeholder({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-slate-600 dark:text-slate-300">{body}</p>
      {children}
    </section>
  );
}
