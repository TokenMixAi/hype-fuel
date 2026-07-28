import {useCallback, useEffect, useState} from "react";

import {fetchRelayerConfig, type ConfigResponse} from "../api";

/** Loads the relayer's live configuration, including fee schedule and HYPE inventory. */
export function useRelayerConfig() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConfig(await fetchRelayerConfig());
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `Could not load service details: ${caught.message}`
          : "Could not load service details.",
      );
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {config, error, reload};
}
