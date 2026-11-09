import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { meQuery, setupStatusQuery } from "../hooks/use-me";

/**
 * Pathless layout for every signed-in screen. No session: first run goes to /setup, otherwise to /login.
 * Add a tab or screen as `src/client/routes/_app.<name>.tsx`; it inherits this guard and the shell.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery());
    if (me) return { me };
    const setup = await context.queryClient.fetchQuery(setupStatusQuery());
    if (setup.needed) throw redirect({ to: "/setup" });
    throw redirect({ to: "/login", search: { next: location.href } });
  },
  component: AppShell,
});
