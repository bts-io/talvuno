import { queryOptions } from "@tanstack/react-query";
import type { AuthConfig, Me, SetupStatus } from "../../contracts";
import { ApiError, api } from "../lib/api";

/** The signed-in owner, or null when there is no session. */
export const meQuery = () =>
  queryOptions({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<Me>("/api/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });

export const authConfigQuery = () =>
  queryOptions({
    queryKey: ["auth-config"],
    queryFn: () => api<AuthConfig>("/api/auth-config"),
    staleTime: 60_000,
  });

export const setupStatusQuery = () =>
  queryOptions({
    queryKey: ["setup"],
    queryFn: () => api<SetupStatus>("/api/setup"),
    staleTime: 0,
  });
