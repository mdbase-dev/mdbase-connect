import { useState } from "react";
import { message } from "./view-model";

export function useLocalAction(run: (action: () => Promise<void>) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    act: (action: () => Promise<unknown>) => {
      setError(null);
      return run(async () => {
        try { await action(); }
        catch (reason) { setError(message(reason)); }
      });
    }
  };
}
