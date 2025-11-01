"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type HydrationSettings = {
  dailyGoalMl: number;
  cupSizeMl: number;
  wakeTime: string;
  sleepTime: string;
  reminderIntervalMinutes: number;
  notificationsEnabled: boolean;
};

type WaterLog = {
  id: string;
  amountMl: number;
  note?: string;
  createdAt: string;
};

type StoredState = {
  settings: HydrationSettings;
  logs: WaterLog[];
};

const STORAGE_KEY = "hydrate.reminder.v1";

const DEFAULT_SETTINGS: HydrationSettings = {
  dailyGoalMl: 2000,
  cupSizeMl: 250,
  wakeTime: "07:00",
  sleepTime: "22:30",
  reminderIntervalMinutes: 90,
  notificationsEnabled: false,
};

const QUICK_ADD_AMOUNTS = [150, 200, 250, 500];

const formatTime = (date: Date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatMinutes = (totalMinutes: number) => {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} menit`;
  if (minutes === 0) return `${hours} jam`;
  return `${hours} jam ${minutes} menit`;
};

const withinHydrationWindow = (date: Date, settings: HydrationSettings) => {
  const { wakeTime, sleepTime } = settings;
  const [wakeHour, wakeMinute] = wakeTime.split(":").map(Number);
  const [sleepHour, sleepMinute] = sleepTime.split(":").map(Number);

  const wakeDate = new Date(date);
  wakeDate.setHours(wakeHour, wakeMinute, 0, 0);

  const sleepDate = new Date(date);
  sleepDate.setHours(sleepHour, sleepMinute, 0, 0);

  if (sleepDate <= wakeDate) {
    sleepDate.setDate(sleepDate.getDate() + 1);
  }

  return date >= wakeDate && date <= sleepDate;
};

const getUpcomingReminder = (
  now: Date,
  settings: HydrationSettings,
  lastLog?: Date,
) => {
  const { wakeTime, sleepTime, reminderIntervalMinutes } = settings;
  const [wakeHour, wakeMinute] = wakeTime.split(":").map(Number);
  const [sleepHour, sleepMinute] = sleepTime.split(":").map(Number);

  const wakeDate = new Date(now);
  wakeDate.setHours(wakeHour, wakeMinute, 0, 0);

  const sleepDate = new Date(now);
  sleepDate.setHours(sleepHour, sleepMinute, 0, 0);
  if (sleepDate <= wakeDate) {
    sleepDate.setDate(sleepDate.getDate() + 1);
  }

  const base = lastLog && withinHydrationWindow(lastLog, settings)
    ? new Date(lastLog)
    : new Date(Math.max(now.getTime(), wakeDate.getTime()));

  let reminderTime = new Date(base);
  reminderTime.setMinutes(reminderTime.getMinutes() + reminderIntervalMinutes);

  if (!withinHydrationWindow(reminderTime, settings)) {
    return null;
  }

  if (reminderTime <= now) {
    reminderTime = new Date(now.getTime() + reminderIntervalMinutes * 60 * 1000);
    if (!withinHydrationWindow(reminderTime, settings)) {
      return null;
    }
  }

  if (reminderTime > sleepDate) {
    return null;
  }

  return reminderTime;
};

const persistState = (state: StoredState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to persist hydration state", error);
  }
};

const loadState = (): StoredState | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    return parsed;
  } catch (error) {
    console.error("Failed to read hydration state", error);
    return null;
  }
};

const requestNotificationPermission = async () => {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
};

const triggerLocalNotification = (title: string, body: string) => {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch (error) {
    console.warn("Failed to send notification", error);
  }
};

const hydrateLogsFromStorage = (logs: WaterLog[]) => {
  if (!Array.isArray(logs)) return [];
  return logs
    .map((log) => ({
      ...log,
      createdAt: log.createdAt ?? new Date().toISOString(),
      amountMl: Number(log.amountMl) || 0,
    }))
    .filter((log) => log.amountMl > 0)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
};

const calculateTodayProgress = (logs: WaterLog[]) => {
  const today = new Date();
  const startOfDay = new Date(today);
  startOfDay.setHours(0, 0, 0, 0);
  return logs
    .filter((log) => new Date(log.createdAt) >= startOfDay)
    .reduce((acc, log) => acc + log.amountMl, 0);
};

export function HydrationDashboard() {
  const [settings, setSettings] = useState<HydrationSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    const stored = loadState();
    if (stored?.settings) {
      return { ...DEFAULT_SETTINGS, ...stored.settings };
    }
    return DEFAULT_SETTINGS;
  });

  const [logs, setLogs] = useState<WaterLog[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = loadState();
    if (stored?.logs) {
      return hydrateLogsFromStorage(stored.logs);
    }
    return [];
  });
  const [volumeInput, setVolumeInput] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS.cupSizeMl;
    const stored = loadState();
    if (stored?.settings?.cupSizeMl) {
      return stored.settings.cupSizeMl;
    }
    return DEFAULT_SETTINGS.cupSizeMl;
  });
  const [noteInput, setNoteInput] = useState("");
  const [now, setNow] = useState(() => new Date());
  const notificationTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const dailyIntake = useMemo(() => calculateTodayProgress(logs), [logs]);

  const hydrationPercent = Math.min(
    100,
    Math.round((dailyIntake / settings.dailyGoalMl) * 100),
  );

  const remainingMl = Math.max(settings.dailyGoalMl - dailyIntake, 0);

  useEffect(() => {
    persistState({ settings, logs });
  }, [settings, logs]);

  const addLog = useCallback(
    (amount: number, note?: string) => {
      const log: WaterLog = {
        id: `${Date.now()}`,
        amountMl: amount,
        note: note?.trim() || undefined,
        createdAt: new Date().toISOString(),
      };
      setLogs((prev) => hydrateLogsFromStorage([log, ...prev]));
    },
    [],
  );

  const removeLog = useCallback((id: string) => {
    setLogs((prev) => prev.filter((log) => log.id !== id));
  }, []);

  const lastLog = useMemo(() => {
    if (!logs.length) return undefined;
    const [latest] = logs;
    return new Date(latest.createdAt);
  }, [logs]);

  useEffect(() => {
    const update = () => setNow(new Date());
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, []);

  const reminderTime = useMemo(
    () => getUpcomingReminder(now, settings, lastLog),
    [now, settings, lastLog],
  );

  const countdown = useMemo(() => {
    if (!reminderTime) return null;
    const diffMs = reminderTime.getTime() - now.getTime();
    if (diffMs <= 0) {
      return "Sudah waktunya minum air!";
    }
    const diffMinutes = Math.round(diffMs / 60000);
    const minutesPart = diffMinutes % 60;
    const hoursPart = Math.floor(diffMinutes / 60);
    return hoursPart
      ? `${hoursPart} jam ${minutesPart} menit`
      : `${minutesPart} menit`;
  }, [reminderTime, now]);

  useEffect(() => {
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
      notificationTimeoutRef.current = null;
    }

    if (!settings.notificationsEnabled || !reminderTime) return;

    const diff = reminderTime.getTime() - Date.now();
    if (diff <= 0) return;

    notificationTimeoutRef.current = setTimeout(() => {
      triggerLocalNotification(
        "Saatnya minum air putih 💧",
        "Tetap terhidrasi agar tubuh tetap segar!",
      );
    }, diff);

    return () => {
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
        notificationTimeoutRef.current = null;
      }
    };
  }, [reminderTime, settings.notificationsEnabled]);

  const handleNotificationToggle = async () => {
    if (settings.notificationsEnabled) {
      setSettings((prev) => ({ ...prev, notificationsEnabled: false }));
      return;
    }

    const permission = await requestNotificationPermission();
    if (permission === "granted") {
      setSettings((prev) => ({ ...prev, notificationsEnabled: true }));
      triggerLocalNotification(
        "Pengingat aktif ✅",
        "Kami akan mengabari kamu saat waktunya minum.",
      );
    } else {
      setSettings((prev) => ({ ...prev, notificationsEnabled: false }));
    }
  };

  const handleGoalChange = (value: number) => {
    setSettings((prev) => ({ ...prev, dailyGoalMl: value }));
  };

  const handleCupSizeChange = (value: number) => {
    setSettings((prev) => ({ ...prev, cupSizeMl: value }));
    setVolumeInput(value);
  };

  const handleScheduleChange = (key: keyof HydrationSettings, value: string | number) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const todaysLogs = useMemo(() => {
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    return logs.filter((log) => new Date(log.createdAt) >= startOfDay);
  }, [logs]);

  const resetToday = useCallback(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    setLogs((prev) =>
      prev.filter((log) => new Date(log.createdAt) < startOfDay),
    );
  }, []);

  const hydrationTips = useMemo(
    () => [
      "Minum segelas air segera setelah bangun tidur.",
      "Tambahkan irisan lemon atau mentimun agar lebih segar.",
      "Gunakan gelas bertanda untuk memudahkan pengukuran.",
      "Sesuaikan kebutuhan cairan saat cuaca panas atau olahraga.",
      "Simpan botol air di tempat yang mudah terlihat.",
    ],
    [],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-12">
      <section className="rounded-3xl bg-gradient-to-br from-sky-500 via-sky-500/90 to-cyan-500 p-6 shadow-lg sm:p-8">
        <div className="flex flex-col gap-5 text-white">
          <div className="flex flex-col gap-2">
            <span className="text-sm uppercase tracking-wide opacity-80">
              Target Harian
            </span>
            <h1 className="text-3xl font-semibold sm:text-4xl">
              {Math.round(settings.dailyGoalMl / 100) / 10} L
            </h1>
          </div>
          <div>
            <div className="flex items-center justify-between text-sm">
              <p className="opacity-90">Total hari ini</p>
              <p className="font-semibold">
                {dailyIntake} ml • {hydrationPercent}%
              </p>
            </div>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white transition-all duration-300"
                style={{ width: `${hydrationPercent}%` }}
              />
            </div>
            <p className="mt-2 text-sm opacity-90">
              Sisa {remainingMl} ml untuk mencapai target hari ini.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={handleNotificationToggle}
              className="flex items-center justify-between rounded-2xl bg-white/15 px-4 py-3 text-left text-sm font-medium backdrop-blur transition hover:bg-white/25"
            >
              <div>
                <p className="text-base font-semibold">
                  {settings.notificationsEnabled ? "Pengingat aktif" : "Aktifkan pengingat"}
                </p>
                <p className="text-xs opacity-80">
                  Terima pemberitahuan tepat waktu.
                </p>
              </div>
              <span
                className={`inline-flex h-6 w-12 items-center rounded-full px-1 transition ${
                  settings.notificationsEnabled ? "bg-white" : "bg-white/30"
                }`}
              >
                <span
                  className={`h-4 w-4 rounded-full bg-sky-500 transition ${
                    settings.notificationsEnabled ? "translate-x-6" : "translate-x-0"
                  }`}
                />
              </span>
            </button>
            <div className="rounded-2xl bg-white/15 px-4 py-3 text-sm backdrop-blur">
              <p className="text-xs uppercase tracking-wide opacity-70">
                Pengingat selanjutnya
              </p>
              <p className="mt-1 text-lg font-semibold">
                {reminderTime ? formatTime(reminderTime) : "Tidak ada"}
              </p>
              <p className="text-xs opacity-80">
                {countdown
                  ? `Dalam ${countdown}`
                  : "Atur jadwal agar pengingat berjalan."}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <div className="space-y-6 rounded-3xl border border-sky-100 bg-white p-5 shadow-sm">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Catat Minumanmu
            </h2>
            <div className="flex flex-wrap gap-2">
              {QUICK_ADD_AMOUNTS.map((amount) => (
                <button
                  key={amount}
                  onClick={() => addLog(amount)}
                  className="rounded-full border border-sky-100 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700 transition hover:bg-sky-100"
                >
                  +{amount} ml
                </button>
              ))}
            </div>
            <form
              className="grid gap-3 sm:grid-cols-[1fr,1fr] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (volumeInput <= 0) return;
                addLog(volumeInput, noteInput);
                setNoteInput("");
              }}
            >
              <label className="flex flex-col gap-1 text-sm text-slate-700">
                Volume (ml)
                <input
                  type="number"
                  min={50}
                  step={25}
                  required
                  value={volumeInput}
                  onChange={(event) => setVolumeInput(Number(event.target.value))}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-base focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-700 sm:col-span-2">
                Catatan singkat (opsional)
                <input
                  type="text"
                  value={noteInput}
                  onChange={(event) => setNoteInput(event.target.value)}
                  placeholder="Misal: setelah olahraga"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-base focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                />
              </label>
              <button
                type="submit"
                className="sm:col-span-2 mt-2 inline-flex items-center justify-center rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-600"
              >
                Tambahkan
              </button>
            </form>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Riwayat hari ini
              </h3>
              <button
                onClick={resetToday}
                className="text-xs font-medium text-slate-400 hover:text-slate-600"
              >
                Reset hari ini
              </button>
            </div>
            {todaysLogs.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                Belum ada catatan. Mulai dengan menekan salah satu tombol cepat.
              </p>
            ) : (
              <ul className="space-y-3">
                {todaysLogs.map((log) => (
                  <li
                    key={log.id}
                    className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-700"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        +{log.amountMl} ml
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatTime(new Date(log.createdAt))}
                        {log.note ? ` • ${log.note}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => removeLog(log.id)}
                      className="text-xs font-semibold text-slate-400 hover:text-red-500"
                    >
                      Hapus
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">
              Penyesuaian target
            </h2>
            <div className="mt-4 space-y-4 text-sm text-slate-600">
              <label className="flex flex-col gap-1">
                Target harian (ml)
                <input
                  type="range"
                  min={1200}
                  max={4000}
                  step={100}
                  value={settings.dailyGoalMl}
                  onChange={(event) => handleGoalChange(Number(event.target.value))}
                />
                <span className="text-xs text-slate-500">
                  {settings.dailyGoalMl} ml
                </span>
              </label>
              <label className="flex flex-col gap-1">
                Ukuran gelas favorit (ml)
                <select
                  value={settings.cupSizeMl}
                  onChange={(event) => handleCupSizeChange(Number(event.target.value))}
                  className="rounded-xl border border-slate-200 px-3 py-2 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                >
                  {[150, 200, 250, 300, 350, 500].map((option) => (
                    <option key={option} value={option}>
                      {option} ml
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Waktu mulai hari
                <input
                  type="time"
                  value={settings.wakeTime}
                  onChange={(event) => handleScheduleChange("wakeTime", event.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                />
              </label>
              <label className="flex flex-col gap-1">
                Waktu istirahat malam
                <input
                  type="time"
                  value={settings.sleepTime}
                  onChange={(event) => handleScheduleChange("sleepTime", event.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                />
              </label>
              <label className="flex flex-col gap-1">
                Jeda antar pengingat
                <select
                  value={settings.reminderIntervalMinutes}
                  onChange={(event) =>
                    handleScheduleChange("reminderIntervalMinutes", Number(event.target.value))
                  }
                  className="rounded-xl border border-slate-200 px-3 py-2 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
                >
                  {[45, 60, 75, 90, 120, 180].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {formatMinutes(minutes)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Tips hidrasi</h2>
            <ul className="mt-3 space-y-2 text-sm text-slate-600">
              {hydrationTips.map((tip) => (
                <li key={tip} className="rounded-2xl bg-slate-50 px-3 py-2">
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </section>
    </div>
  );
}
