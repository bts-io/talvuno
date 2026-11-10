import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePhone } from "../components/phone-provider";

/**
 * Where an incoming call notice opens: answers the waiting call as soon as calling is ready, then hands over
 * to the call screen (which sits over every page) and leaves for Recents. Answering again is refused by the
 * Worker when another device was first, so the caller hears the call ended on this side only.
 */
export const Route = createFileRoute("/_app/answer/$callId")({ component: AnswerPage });

function AnswerPage() {
  const { t } = useTranslation();
  const { callId } = Route.useParams();
  const { deviceState, answer, active, error, failed, retry } = usePhone();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || deviceState !== "ready") return;
    started.current = true;
    void answer(callId);
  }, [deviceState, answer, callId]);

  useEffect(() => {
    if (active) void navigate({ to: "/recents", replace: true });
  }, [active, navigate]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">{t("routing.answering")}</h1>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t(`voice.errors.${error}`)}
        </p>
      ) : null}
      {failed ? (
        <button
          type="button"
          onClick={retry}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium dark:border-navy-700"
        >
          {t("voice.retry")}
        </button>
      ) : null}
    </div>
  );
}
