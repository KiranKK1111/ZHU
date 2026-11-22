import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { qk } from "@/app/providers/queryKeys";
import { toast } from "@/app/state/ui";
import { useSettingsQuery } from "@/hooks/useSessionData";
import { api } from "@/services/engine";
import type { SettingsPatch } from "@/types/engine";
import { errorMessage } from "@/utils/format";

/** Engine settings with server validation; "Settings saved" appears only after the engine accepts the change. */
export function useEngineSettings() {
  const qc = useQueryClient();
  const query = useSettingsQuery();
  const update = useCallback(
    async (patch: SettingsPatch, quiet = false) => {
      try {
        const next = await api.updateSettings(patch);
        qc.setQueryData(qk.settings, next);
        if (!quiet) toast.success("Settings saved");
        return true;
      } catch (err) {
        toast.error("Settings not saved", errorMessage(err));
        void qc.invalidateQueries({ queryKey: qk.settings });
        return false;
      }
    },
    [qc],
  );
  return { settings: query.data, isLoading: query.isLoading, error: query.error, update };
}
