"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Gauge, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import type { Article } from "@/lib/rss-data";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;
type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

const SPEED_STORAGE_KEY = "ff_audio_playback_speed";

function getStoredSpeed(): PlaybackSpeed {
  if (typeof window === "undefined") return 1;
  try {
    const stored = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    if (PLAYBACK_SPEEDS.includes(stored as PlaybackSpeed)) {
      return stored as PlaybackSpeed;
    }
  } catch {
    // Ignore storage errors
  }
  return 1;
}

function getStoredPosition(articleId: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const val = Number(localStorage.getItem(`ff_audio_pos_${articleId}`));
    return Number.isFinite(val) && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

function savePosition(articleId: string, time: number, duration: number) {
  if (typeof window === "undefined") return;
  try {
    // If completed or within 5s of end, reset position so re-playing starts fresh.
    if (duration > 0 && time >= duration - 5) {
      localStorage.removeItem(`ff_audio_pos_${articleId}`);
    } else if (time > 0) {
      localStorage.setItem(`ff_audio_pos_${articleId}`, String(Math.floor(time)));
    }
  } catch {
    // Ignore storage errors
  }
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export interface PodcastPlayerProps {
  article: Article;
  src: string;
  durationSecs?: number | null;
}

export function PodcastPlayer({ article, src, durationSecs }: PodcastPlayerProps) {
  const t = useTranslations("podcastPlayer");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSecs ?? 0);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [isSeeking, setIsSeeking] = useState(false);

  // Initialize saved speed on mount
  useEffect(() => {
    const initialSpeed = getStoredSpeed();
    setSpeed(initialSpeed);
  }, []);

  // Set initial position once audio metadata is ready
  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    const savedPos = getStoredPosition(article.id);
    if (savedPos > 0 && savedPos < audio.duration) {
      audio.currentTime = savedPos;
      setCurrentTime(savedPos);
    }
    audio.playbackRate = speed;
  }, [article.id, speed]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  const seekRelative = useCallback((deltaSecs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, Math.min(audio.currentTime + deltaSecs, audio.duration || Number.POSITIVE_INFINITY));
    audio.currentTime = target;
    setCurrentTime(target);
    savePosition(article.id, target, audio.duration);
  }, [article.id]);

  const seekTo = useCallback((targetSecs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const bounded = Math.max(0, Math.min(targetSecs, audio.duration || Number.POSITIVE_INFINITY));
    audio.currentTime = bounded;
    setCurrentTime(bounded);
    savePosition(article.id, bounded, audio.duration);
  }, [article.id]);

  const cycleSpeed = useCallback(() => {
    const idx = PLAYBACK_SPEEDS.indexOf(speed);
    const nextSpeed = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
    setSpeed(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
    try {
      localStorage.setItem(SPEED_STORAGE_KEY, String(nextSpeed));
    } catch {
      // Ignore
    }
  }, [speed]);

  // Sync state on audio events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => {
      setIsPlaying(false);
      savePosition(article.id, audio.currentTime, audio.duration);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      savePosition(article.id, audio.duration, audio.duration);
    };
    const handleTimeUpdate = () => {
      if (!isSeeking) {
        setCurrentTime(audio.currentTime);
      }
      savePosition(article.id, audio.currentTime, audio.duration);
    };
    const handleDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("durationchange", handleDurationChange);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("durationchange", handleDurationChange);
    };
  }, [article.id, isSeeking]);

  // Media Session API integration
  useEffect(() => {
    if (typeof window === "undefined" || !("mediaSession" in navigator)) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: article.title,
        artist: article.feedName || article.author || undefined,
        album: article.feedName || undefined,
        artwork: article.imageUrl ? [{ src: article.imageUrl }] : undefined,
      });

      navigator.mediaSession.setActionHandler("play", () => {
        audioRef.current?.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        audioRef.current?.pause();
      });
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        seekRelative(-(details.seekOffset || 15));
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        seekRelative(details.seekOffset || 30);
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime != null) {
          seekTo(details.seekTime);
        }
      });
    } catch {
      // Ignore media session errors
    }

    return () => {
      try {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("seekbackward", null);
        navigator.mediaSession.setActionHandler("seekforward", null);
        navigator.mediaSession.setActionHandler("seekto", null);
      } catch {
        // Ignore
      }
    };
  }, [article.title, article.feedName, article.author, article.imageUrl, seekRelative, seekTo]);

  // Update Media Session position state
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("mediaSession" in navigator) ||
      !("setPositionState" in navigator.mediaSession) ||
      !duration ||
      !Number.isFinite(duration)
    ) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(0, duration),
        playbackRate: speed,
        position: Math.max(0, Math.min(currentTime, duration)),
      });
    } catch {
      // Ignore
    }
  }, [currentTime, duration, speed]);

  // Keyboard shortcuts when reader is active
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in form inputs
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekRelative(e.shiftKey ? -30 : -15);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekRelative(30);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, seekRelative]);

  const maxDuration = duration > 0 ? duration : 100;

  return (
    <div
      className="ff-podcast-player mb-6 rounded-panel border border-border/60 bg-card/85 p-4"
      data-testid="podcast-player"
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
      />

      <div className="flex items-center gap-3">
        {/* Play / Pause */}
        <Button
          type="button"
          size="icon"
          variant="default"
          onClick={togglePlay}
          aria-label={isPlaying ? t("pause") : t("play")}
          className="rounded-full"
          data-testid="podcast-play-button"
        >
          {isPlaying ? <Pause className="size-5 fill-current" /> : <Play className="size-5 translate-x-px fill-current" />}
        </Button>

        {/* Skip -15s */}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => seekRelative(-15)}
          aria-label={t("skipBack15")}
          title={t("skipBack15")}
          className="rounded-full"
          data-testid="podcast-skip-back"
        >
          <RotateCcw className="size-4" />
        </Button>

        {/* Skip +30s */}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => seekRelative(30)}
          aria-label={t("skipForward30")}
          title={t("skipForward30")}
          className="rounded-full"
          data-testid="podcast-skip-forward"
        >
          <RotateCw className="size-4" />
        </Button>

        {/* Progress & timestamps */}
        <div className="min-w-0 flex-1 px-2">
          <Slider
            data-testid="podcast-progress-slider"
            aria-label={t("seek")}
            value={[currentTime]}
            max={maxDuration}
            step={1}
            onValueChange={([val]) => {
              setIsSeeking(true);
              setCurrentTime(val);
            }}
            onValueCommit={([val]) => {
              setIsSeeking(false);
              seekTo(val);
            }}
            className="py-1"
          />
          <div className="mt-1 flex justify-between text-caption tabular-nums text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
          </div>
        </div>

        {/* Playback speed selector */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={cycleSpeed}
          aria-label={`${t("speed")}: ${speed}x`}
          title={`${t("speed")}: ${speed}x`}
          className="h-8 rounded-panel px-2 text-caption font-semibold tabular-nums text-muted-foreground hover:text-foreground"
          data-testid="podcast-speed-button"
        >
          <Gauge className="size-3.5" aria-hidden />
          <span>{speed}×</span>
        </Button>
      </div>
    </div>
  );
}
