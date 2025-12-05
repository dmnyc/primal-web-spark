/**
 * Emergency wallet reset utility
 *
 * This can be called from the browser console to force-clear all Breez wallet data
 * when the wallet is stuck/hanging.
 *
 * Usage in browser console:
 *   window.resetBreezWallet()
 */

export async function resetBreezWallet(): Promise<void> {
  console.log('=== EMERGENCY BREEZ WALLET RESET ===');
  console.log('This will clear all wallet data. You will need to restore from mnemonic.');

  try {
    // 1. Clear IndexedDB
    console.log('[Reset] Step 1/4: Clearing IndexedDB...');
    const dbNames = ['breez-spark-wallet', 'breez_sdk_spark', 'spark-wallet-example'];

    for (const dbName of dbNames) {
      try {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(dbName);
          request.onsuccess = () => {
            console.log(`[Reset] Deleted database: ${dbName}`);
            resolve(undefined);
          };
          request.onerror = () => {
            console.log(`[Reset] Database ${dbName} doesn't exist or already deleted`);
            resolve(undefined);
          };
          request.onblocked = () => {
            console.warn(`[Reset] Database ${dbName} deletion blocked`);
            resolve(undefined);
          };
        });
      } catch (e) {
        console.log(`[Reset] Error deleting ${dbName}:`, e);
      }
    }

    // 2. Clear localStorage
    console.log('[Reset] Step 2/4: Clearing localStorage...');
    const keysToRemove = [
      'breez_sdk_version',
      'spark_seed',
      'spark_config',
      'breez_wallet_state',
    ];

    for (const key of keysToRemove) {
      try {
        // Check for keys with pubkey suffix
        for (let i = 0; i < localStorage.length; i++) {
          const storageKey = localStorage.key(i);
          if (storageKey?.startsWith(key)) {
            localStorage.removeItem(storageKey);
            console.log(`[Reset] Removed localStorage: ${storageKey}`);
          }
        }
        // Also remove exact key
        localStorage.removeItem(key);
      } catch (e) {
        console.log(`[Reset] Error removing ${key}:`, e);
      }
    }

    // 3. Clear sessionStorage
    console.log('[Reset] Step 3/4: Clearing sessionStorage...');
    try {
      sessionStorage.clear();
    } catch (e) {
      console.log('[Reset] Error clearing sessionStorage:', e);
    }

    // 4. Reload page
    console.log('[Reset] Step 4/4: Reloading page...');
    console.log('=== RESET COMPLETE ===');
    console.log('Reloading in 2 seconds...');

    setTimeout(() => {
      window.location.reload();
    }, 2000);

  } catch (error) {
    console.error('[Reset] Reset failed:', error);
    console.log('Manual reset required:');
    console.log('1. Open DevTools > Application > IndexedDB > Delete all Breez databases');
    console.log('2. Open DevTools > Application > LocalStorage > Clear all breez/spark keys');
    console.log('3. Reload page');
  }
}

// Make it available globally for console access
if (typeof window !== 'undefined') {
  (window as any).resetBreezWallet = resetBreezWallet;
  console.log('💡 Emergency reset available: window.resetBreezWallet()');
}
