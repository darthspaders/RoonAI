"use strict";

(() => {
  const REFRESH_MS = 15 * 60 * 1000;
  const pad = n => String(n).padStart(2, "0");
  const localTime = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const dateLabel = date => date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const DIGITS = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
  const SEGMENTS = {
    a: "5,1 25,1 28,4 24,7 6,7 2,4", b: "26,7 29,5 29,24 26,27 23,24 23,10",
    c: "26,29 29,32 29,51 26,54 23,50 23,33", d: "6,51 24,51 28,55 25,58 5,58 2,55",
    e: "3,29 6,33 6,50 3,54 0,51 0,32", f: "3,5 6,10 6,24 3,27 0,24 0,8",
    g: "6,26 23,26 27,29 23,32 6,32 2,29"
  };
  function clockDigits(label) {
    return [...label].map(char => char === ":"
      ? '<svg class="rabbitRemoteColon" viewBox="0 0 9 60" aria-hidden="true"><circle cx="4.5" cy="20" r="2" fill="currentColor"/><circle cx="4.5" cy="40" r="2" fill="currentColor"/></svg>'
      : `<svg class="rabbitRemoteDigit" viewBox="0 0 30 60" aria-hidden="true">${Object.entries(SEGMENTS).map(([key, points]) => `<polygon points="${points}" fill="currentColor" opacity="${DIGITS[Number(char)]?.includes(key) ? 1 : .06}"/>`).join("")}</svg>`).join("");
  }
  function condition(code, isDay = 1) {
    if (code === 0) return { label: "Clear", icon: isDay ? "sun" : "moon" };
    if ([1, 2].includes(code)) return { label: "Partly cloudy", icon: "cloud" };
    if (code === 3) return { label: "Overcast", icon: "cloud" };
    if ([45, 48].includes(code)) return { label: "Fog", icon: "fog" };
    if ([51, 53, 55, 56, 57].includes(code)) return { label: "Drizzle", icon: "rain" };
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: "Rain", icon: "rain" };
    if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: "Snow", icon: "snow" };
    if ([95, 96, 99].includes(code)) return { label: "Thunderstorm", icon: "storm" };
    return { label: "Conditions unknown", icon: "cloud" };
  }
  function weatherIcon(kind) {
    const cloud = '<path d="M6 16a4 4 0 0 1-1-8 6 6 0 0 1 11-1 4.5 4.5 0 1 1 2 9Z"/>';
    const shapes = {
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
      moon: '<path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z"/>',
      cloud, fog: cloud + '<path d="M3 20h18M7 23h10"/>',
      rain: cloud + '<path d="m7 19-1 3m6-3-1 3m6-3-1 3"/>',
      snow: cloud + '<path d="M7 20v3m-1.5-1.5h3M17 20v3m-1.5-1.5h3"/>',
      storm: cloud + '<path d="m12 17-3 4h4l-2 3"/>'
    };
    return `<svg class="rabbitRemoteWeatherIcon" viewBox="0 0 24 26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[kind] || cloud}</svg>`;
  }
  async function fetchWeather(coords, { fetchImpl = globalThis.fetch, signal, now = Date.now } = {}) {
    if (!Number.isFinite(coords?.latitude) || !Number.isFinite(coords?.longitude) || Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180) throw Error("Location unavailable.");
    const params = new URLSearchParams({ latitude: coords.latitude.toFixed(2), longitude: coords.longitude.toFixed(2),
      current: "temperature_2m,weather_code,is_day", temperature_unit: "fahrenheit", timeformat: "unixtime", forecast_days: "1" });
    const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store"
    });
    if (!response.ok) throw Error(response.status === 429 ? "Weather provider is busy. Trying again later." : "Weather unavailable. Trying again later.");
    const data = await response.json(), current = data.current;
    if (!Number.isFinite(current?.temperature_2m) || !Number.isFinite(current?.weather_code) || data.current_units?.temperature_2m !== "°F") throw Error("Weather response unavailable.");
    const age = now() - Number(current.time) * 1000;
    if (!Number.isFinite(age) || age > 90 * 60 * 1000 || age < -10 * 60 * 1000) throw Error("Weather update is out of date.");
    return { temperature: Math.round(current.temperature_2m), ...condition(current.weather_code, current.is_day), updatedAt: Number(current.time) * 1000 };
  }
  function createWeatherController({ locate, fetchCurrent, render, persist = () => {}, visible = () => true, now = Date.now }) {
    let enabled = false, busy = false, next = 0, epoch = 0, controller = null;
    function disable() {
      enabled = false; epoch++; busy = false; controller?.abort(); persist(false);
      render({ enabled: false, message: "Weather is off. Your location is not being requested." });
    }
    async function refresh() {
      if (!enabled || busy || !visible() || now() < next) return;
      const generation = ++epoch; busy = true; next = now() + REFRESH_MS;
      controller = new AbortController(); const currentController = controller;
      const timeout = setTimeout(() => currentController.abort(), 25000);
      render({ enabled: true, busy: true, message: "Getting weather for your approximate location…" });
      try {
        const position = await locate();
        if (!enabled || generation !== epoch || !visible()) return;
        const weather = await fetchCurrent(position.coords, { signal: currentController.signal });
        if (enabled && generation === epoch) render({ enabled: true, weather,
          message: `Nearby modeled conditions, updated ${localTime(new Date(weather.updatedAt))}. Updates every 15 minutes while visible. Approximate location goes directly to Open-Meteo and is not stored by Rabbit Hole.` });
      } catch (error) {
        if (!enabled || generation !== epoch) return;
        if (error.code === 1) { enabled = false; persist(false); }
        render({ enabled, message: error.code === 1 ? "Location permission was declined. Allow location for this site, then try again."
          : error.code === 2 || error.code === 3 ? "Phone location is unavailable. Trying again later."
          : "Weather unavailable. Trying again later." });
      } finally { clearTimeout(timeout); if (generation === epoch) busy = false; }
    }
    return { disable, refresh, isEnabled: () => enabled,
      enable() { if (enabled) return; enabled = true; next = 0; persist(true); return refresh(); },
      suspend() { epoch++; controller?.abort(); if (busy) next = 0; busy = false; }
    };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { localTime, localDate, dateLabel, clockDigits, condition, fetchWeather, createWeatherController };
  if (typeof document === "undefined") return;

  const clock = document.getElementById("remoteClock"), date = document.getElementById("remoteDate");
  function updateClock() {
    if (document.hidden || !clock || !date) return;
    const now = new Date(), time = localTime(now), day = localDate(now);
    if (clock.getAttribute("datetime") !== time) {
      clock.innerHTML = clockDigits(time); clock.setAttribute("datetime", time); clock.setAttribute("aria-label", `Local time ${time}`);
    }
    if (date.getAttribute("datetime") !== day) { date.textContent = dateLabel(now); date.setAttribute("datetime", day); }
  }
  const summary = document.getElementById("remoteWeatherSummary"), status = document.getElementById("remoteWeatherStatus"), toggle = document.getElementById("remoteWeatherToggle");
  const preference = "rabbitRemoteWeatherEnabled";
  const weather = createWeatherController({
    visible: () => !document.hidden,
    locate: () => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 12000 })),
    fetchCurrent: fetchWeather,
    persist: enabled => { try { localStorage.setItem(preference, String(enabled)); } catch {} },
    render: ({ enabled, busy, message, weather: value }) => {
      summary.replaceChildren();
      if (value) {
        summary.innerHTML = weatherIcon(value.icon);
        summary.append(document.createTextNode(`${value.temperature}°F · ${value.label}`));
      } else summary.textContent = busy ? "Getting weather…" : enabled ? "Weather unavailable" : "Enable weather";
      status.textContent = message;
      toggle.textContent = enabled ? "Turn off weather" : "Use phone location";
    }
  });
  function supported() {
    if (!window.isSecureContext || !navigator.geolocation) {
      status.textContent = "Phone location needs HTTPS and a browser that supports location. The clock still works.";
      return false;
    }
    return true;
  }
  toggle?.addEventListener("click", () => { if (weather.isEnabled()) weather.disable(); else if (supported()) void weather.enable(); });
  async function restoreWeather() {
    let optedIn = false; try { optedIn = localStorage.getItem(preference) === "true"; } catch {}
    if (!optedIn || !supported()) return;
    // Do not open a permission prompt automatically on page load.
    try { if ((await navigator.permissions.query({ name: "geolocation" })).state === "granted") void weather.enable(); } catch {}
  }
  updateClock(); void restoreWeather();
  setInterval(() => { updateClock(); void weather.refresh(); }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) weather.suspend(); else { updateClock(); void weather.refresh(); } });
  window.addEventListener("pagehide", () => weather.suspend());
  window.addEventListener("pageshow", () => { updateClock(); void weather.refresh(); });
})();
