import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "./api.js";

export type LiveStatus = "connecting" | "live" | "reconnecting";

/**
 * Subscribes to /api/events. EventSource reconnects on its own and sends the
 * last event id, so the server resumes the change stream without gaps.
 */
export function useLiveFeed(
  namespace: string | undefined,
  onEvent: (e: FeedEvent) => void,
  onReset: () => void,
) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handlers = useRef({ onEvent, onReset });
  handlers.current = { onEvent, onReset };

  useEffect(() => {
    if (!namespace) return;
    let source: EventSource;
    let closed = false;

    const open = () => {
      setStatus("connecting");
      source = new EventSource(`/api/events?namespace=${encodeURIComponent(namespace)}`);
      source.onopen = () => setStatus("live");
      source.onerror = () => setStatus("reconnecting");
      source.addEventListener("memory", (e) => handlers.current.onEvent(JSON.parse(e.data)));
      source.addEventListener("reset", () => {
        // The server couldn't resume from our position. Start fresh and reload data.
        source.close();
        handlers.current.onReset();
        if (!closed) open();
      });
    };
    open();

    return () => {
      closed = true;
      source.close();
    };
  }, [namespace]);

  return status;
}
