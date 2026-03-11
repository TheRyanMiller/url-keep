export async function registerPeriodicSync() {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (!registration) {
      return;
    }

    const periodicSync = (
      registration as ServiceWorkerRegistration & {
        periodicSync?: {
          register(
            tag: string,
            options?: { minInterval: number },
          ): Promise<void>;
        };
      }
    ).periodicSync;

    if (!periodicSync) {
      return;
    }

    const status = await navigator.permissions.query({
      name: "periodic-background-sync" as PermissionName,
    });

    if (status.state !== "granted") {
      return;
    }

    await periodicSync.register("url-keep-sync", {
      minInterval: 60 * 60 * 1000, // 1 hour
    });
  } catch {
    // Periodic Background Sync not supported
  }
}
