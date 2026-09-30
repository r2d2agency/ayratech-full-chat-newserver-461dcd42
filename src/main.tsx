import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const PWA_RECOVERY_KEY = "pwa-bad-precache-recovered";

const recoverFromBrokenServiceWorker = async () => {
  if (sessionStorage.getItem(PWA_RECOVERY_KEY) === "1") {
    return;
  }

  sessionStorage.setItem(PWA_RECOVERY_KEY, "1");

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations
        .filter((registration) => registration.scope.includes(window.location.origin))
        .map((registration) => registration.unregister()));
    }

    if ("caches" in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys
        .filter((key) => key.startsWith('workbox-') || key.startsWith('vite-pwa-'))
        .map((key) => caches.delete(key)));
    }
  } catch {
    // ignore cleanup errors and still reload
  }

  window.location.reload();
};

window.addEventListener("unhandledrejection", (event) => {
  const reason = String(event.reason?.message ?? event.reason ?? "");

  if (reason.includes("bad-precaching-response")) {
    event.preventDefault();
    void recoverFromBrokenServiceWorker();
    return;
  }

  if (
    reason.includes("insertBefore") ||
    reason.includes("removeChild") ||
    reason.includes("NotFoundError")
  ) {
    event.preventDefault();
  }
});

void import("./lib/pwa");

const savedTheme = localStorage.getItem('app-theme') || 'dark';
const effectiveTheme = savedTheme === 'system' 
  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : savedTheme;
document.documentElement.classList.add(effectiveTheme);

window.addEventListener('error', (event) => {
  if (
    event.message?.includes('insertBefore') ||
    event.message?.includes('removeChild') ||
    event.message?.includes('NotFoundError')
  ) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
});

createRoot(document.getElementById("root")!).render(<App />);

// Splash screen logic
const splash = document.getElementById('splash');
const splashVideo = document.getElementById('splash-video') as HTMLVideoElement | null;
const root = document.getElementById('root');

const removeSplash = () => {
  if (!splash) return;
  if (root) root.style.visibility = 'visible';
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 600);
};

if (splashVideo) {
  splashVideo.addEventListener('ended', removeSplash);
  // Fallback: se o vídeo não reproduzir (ex: política de autoplay)
  setTimeout(removeSplash, 7000);
} else {
  removeSplash();
}
