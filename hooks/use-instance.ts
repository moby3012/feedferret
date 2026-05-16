"use client";

import { useEffect, useState } from "react";

export type InstanceCapabilities = {
  mail: boolean;
  push: boolean;
  magicLink: boolean;
};

export type InstanceInfo = {
  instanceName: string;
  instanceIconDataUrl: string | null;
  registrationsEnabled: boolean;
  capabilities: InstanceCapabilities;
};

const DEFAULT: InstanceInfo = {
  instanceName: "FeedFerret",
  instanceIconDataUrl: null,
  registrationsEnabled: true,
  capabilities: { mail: false, push: false, magicLink: false },
};

let cache: InstanceInfo | null = null;
let inflight: Promise<InstanceInfo> | null = null;

function fetchInstance(): Promise<InstanceInfo> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/instance")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const value: InstanceInfo = {
        instanceName: data?.instanceName || DEFAULT.instanceName,
        instanceIconDataUrl: data?.instanceIconDataUrl || null,
        registrationsEnabled: data?.registrationsEnabled ?? true,
        capabilities: {
          mail: Boolean(data?.capabilities?.mail),
          push: Boolean(data?.capabilities?.push),
          magicLink: Boolean(data?.capabilities?.magicLink),
        },
      };
      cache = value;
      return value;
    })
    .catch(() => DEFAULT)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useInstance(): { data: InstanceInfo | null; loading: boolean } {
  const [data, setData] = useState<InstanceInfo | null>(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (cache) {
      setData(cache);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchInstance().then((value) => {
      if (!cancelled) {
        setData(value);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}
