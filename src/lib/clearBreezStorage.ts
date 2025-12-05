/**
 * Clear Breez SDK IndexedDB storage
 *
 * Use this to reset wallet storage when migrating between SDK versions.
 * This will require the user to restore their wallet from mnemonic.
 */

export async function clearBreezStorage(): Promise<void> {
  try {
    console.log('[clearBreezStorage] Attempting to clear IndexedDB storage...');

    // Clear the main Breez storage
    const dbName = 'breez-spark-wallet';

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);

      request.onsuccess = () => {
        console.log(`[clearBreezStorage] Successfully deleted database: ${dbName}`);
        // Also clear localStorage marker
        localStorage.removeItem('breez_sdk_version');
        resolve();
      };

      request.onerror = () => {
        console.error('[clearBreezStorage] Error deleting database:', request.error);
        reject(request.error);
      };

      request.onblocked = () => {
        console.warn('[clearBreezStorage] Database deletion blocked. Close all tabs using this database.');
        reject(new Error('Database deletion blocked'));
      };
    });
  } catch (error) {
    console.error('[clearBreezStorage] Failed to clear storage:', error);
    throw error;
  }
}

/**
 * Check if we're upgrading from an old SDK version that might have incompatible storage
 */
export function needsStorageMigration(): boolean {
  const storedVersion = localStorage.getItem('breez_sdk_version');
  const currentVersion = '0.5.2';

  // If no version stored, or version is different, we might need migration
  return !storedVersion || storedVersion !== currentVersion;
}
