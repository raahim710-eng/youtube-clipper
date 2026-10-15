"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Shares one <video> element between the player and the panels next to it (transcript, clips),
 * so clicking a line or "Preview" on a clip jumps the same player.
 */
type PlayerApi = {
  /** Callback ref for the <video> element (it may appear later, after processing finishes). */
  attach: (element: HTMLVideoElement | null) => void;
  hasVideo: boolean;
  currentMs: number;
  seek: (ms: number) => void;
  /** Plays [startMs, endMs] and pauses at the end. */
  playRange: (startMs: number, endMs: number) => void;
  /** Pauses and ends any preview. */
  stop: () => void;
  /** The range currently being previewed, if any. */
  previewRange: { startMs: number; endMs: number } | null;
};

const PlayerContext = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  // The element lives in a ref for imperative calls; the state copy re-runs the subscription effect.
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [previewRange, setPreviewRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const stopAt = useRef<number | null>(null);

  const attach = useCallback((node: HTMLVideoElement | null) => {
    elementRef.current = node;
    setElement(node);
  }, []);

  // Subscribe to the media element (an external system) and mirror its time into React state.
  useEffect(() => {
    if (!element) return;
    const onTime = () => {
      const video = elementRef.current;
      if (!video) return;
      const ms = Math.round(video.currentTime * 1000);
      setCurrentMs(ms);
      if (stopAt.current !== null && ms >= stopAt.current) {
        stopAt.current = null;
        video.pause();
        setPreviewRange(null);
      }
    };
    element.addEventListener("timeupdate", onTime);
    return () => element.removeEventListener("timeupdate", onTime);
  }, [element]);

  const seek = useCallback((ms: number) => {
    const video = elementRef.current;
    if (!video) return;
    stopAt.current = null;
    setPreviewRange(null);
    video.currentTime = ms / 1000;
  }, []);

  const playRange = useCallback((startMs: number, endMs: number) => {
    const video = elementRef.current;
    if (!video) return;
    video.currentTime = startMs / 1000;
    stopAt.current = endMs;
    setPreviewRange({ startMs, endMs });
    video.scrollIntoView({ block: "nearest", behavior: "smooth" });
    void video.play().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    stopAt.current = null;
    setPreviewRange(null);
    elementRef.current?.pause();
  }, []);

  const value = useMemo(
    () => ({ attach, hasVideo: element !== null, currentMs, seek, playRange, stop, previewRange }),
    [attach, element, currentMs, seek, playRange, stop, previewRange],
  );
  return <PlayerContext value={value}>{children}</PlayerContext>;
}

export function usePlayer(): PlayerApi {
  const context = useContext(PlayerContext);
  if (!context) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return context;
}

/** The page's video element, wired to the shared player. */
export function SharedVideo(props: React.ComponentProps<"video">) {
  const { attach } = usePlayer();
  return <video ref={attach} {...props} />;
}
