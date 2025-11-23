import { RelayFactory } from '../nTools';
import { logError, logInfo, logWarning } from '../logger';

/**
 * Parse zap receipt event to extract sender, recipient, event ID, and comment
 */
function parseZapReceipt(event: any, invoice: string): {
  senderPubkey: string;
  recipientPubkey: string;
  eventId?: string;
  comment?: string;
} | null {
  try {
    // Extract bolt11 tag
    const bolt11Tag = event.tags?.find((t: string[]) => t[0] === 'bolt11');
    const bolt11 = bolt11Tag?.[1];

    if (!bolt11) {
      return null;
    }

    // Verify this matches our invoice
    if (bolt11 !== invoice) {
      return null;
    }

    console.log('[FetchZapReceipt] ✅ INVOICE MATCH FOUND!', {
      invoice: invoice.substring(0, 30) + '...',
      bolt11: bolt11.substring(0, 30) + '...'
    });

    // Extract description (zap request)
    const descriptionTag = event.tags?.find((t: string[]) => t[0] === 'description');
    const description = descriptionTag?.[1];

    if (!description) {
      logWarning('[FetchZapReceipt] No description in zap receipt');
      return null;
    }

    // Parse zap request from description
    let zapRequest: any;
    try {
      zapRequest = JSON.parse(description);
    } catch (e) {
      logWarning('[FetchZapReceipt] Failed to parse zap request:', e);
      return null;
    }

    if (zapRequest.kind !== 9734) {
      logWarning('[FetchZapReceipt] Description is not a zap request');
      return null;
    }

    // Extract recipient from zap receipt's 'p' tag
    const recipientTag = event.tags?.find((t: string[]) => t[0] === 'p');
    const recipientPubkey = recipientTag?.[1];

    if (!recipientPubkey) {
      logWarning('[FetchZapReceipt] No recipient in zap receipt');
      return null;
    }

    // Extract sender from zap request's pubkey
    const senderPubkey = zapRequest.pubkey;

    if (!senderPubkey) {
      logWarning('[FetchZapReceipt] No sender in zap request');
      return null;
    }

    // Extract event ID from zap receipt's 'e' tag (if zapping a note)
    const eventTag = event.tags?.find((t: string[]) => t[0] === 'e');
    const eventId = eventTag?.[1];

    // Extract comment from zap request content
    const comment = zapRequest.content || '';

    return {
      senderPubkey,
      recipientPubkey,
      eventId,
      comment,
    };
  } catch (error) {
    logError('[FetchZapReceipt] Error parsing zap receipt:', error);
    return null;
  }
}

/**
 * Fetch zap receipt from Nostr relays for a payment
 * Queries for kind 9735 events that match the given invoice
 */
export async function fetchZapReceiptForInvoice(
  invoice: string,
  recipientPubkey: string,
  relayUrls: string[] = [
    'wss://relay.primal.net',
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://nos.lol',
  ]
): Promise<{
  senderPubkey: string;
  recipientPubkey: string;
  eventId?: string;
  comment?: string;
} | null> {
  console.log('[FetchZapReceipt] fetchZapReceiptForInvoice called:', {
    invoice: invoice?.substring(0, 50) + '...',
    invoiceLength: invoice?.length,
    recipientPubkey: recipientPubkey?.slice(0, 16) + '...',
    relayUrls,
  });

  return new Promise((resolve) => {
    let zapReceipt: any = null;
    let completedRelays = 0;
    const totalRelays = relayUrls.length;

    logInfo(`[FetchZapReceipt] Querying ${totalRelays} relays for zap receipt...`);
    console.log('[FetchZapReceipt] Starting relay queries...');

    // Query each relay
    const relayPromises = relayUrls.map(async (url) => {
      try {
        console.log(`[FetchZapReceipt] Setting up relay connection for ${url}...`);
        const relay = new RelayFactory(url);
        console.log(`[FetchZapReceipt] Connecting to ${url}...`);
        await relay.connect();
        console.log(`[FetchZapReceipt] ✓ Connected to ${url}`);

        return new Promise<void>((resolveRelay) => {
          // Filter for kind 9735 events for this recipient
          // We can't filter by bolt11 tag, so we filter by recipient and check bolt11 in onevent
          const filter = {
            kinds: [9735],
            '#p': [recipientPubkey],
            limit: 50, // Get recent zap receipts
          };

          console.log(`[FetchZapReceipt] Subscribing to ${url} with filter:`, filter);

          let eventCount = 0;
          const sub = relay.subscribe([filter], {
            onevent: (event: any) => {
              eventCount++;

              // Log first event for debugging
              if (eventCount === 1) {
                const bolt11Tag = event?.tags?.find((t: string[]) => t[0] === 'bolt11');
                console.log('[FetchZapReceipt] First event bolt11:', bolt11Tag?.[1]);
                console.log('[FetchZapReceipt] Looking for invoice:', invoice);
                console.log('[FetchZapReceipt] Match?', bolt11Tag?.[1] === invoice);
              }

              if (!zapReceipt) {
                const parsed = parseZapReceipt(event, invoice);
                if (parsed) {
                  logInfo('[FetchZapReceipt] ✓ Found matching zap receipt!');
                  logInfo(`[FetchZapReceipt]   Sender: ${parsed.senderPubkey.slice(0, 16)}...`);
                  logInfo(`[FetchZapReceipt]   Recipient: ${parsed.recipientPubkey.slice(0, 16)}...`);
                  logInfo(`[FetchZapReceipt]   Event: ${parsed.eventId || 'none (profile zap)'}`);
                  logInfo(`[FetchZapReceipt]   Comment: ${parsed.comment || 'none'}`);

                  zapReceipt = parsed;
                  sub.close();
                  resolveRelay();
                }
              }
            },
            oneose: () => {
              console.log(`[FetchZapReceipt] EOSE from ${url}`);
              sub.close();
              completedRelays++;

              if (completedRelays >= totalRelays || zapReceipt) {
                resolveRelay();
              }
            },
          });

          // Timeout for this relay after 5 seconds
          setTimeout(() => {
            console.log(`[FetchZapReceipt] Timeout for ${url}`);
            sub.close();
            resolveRelay();
          }, 5000);
        });
      } catch (error) {
        console.error(`[FetchZapReceipt] Error querying ${url}:`, error);
        logWarning(`[FetchZapReceipt] Failed to query ${url}:`, error);
      }
    });

    // Wait for all relays or until we find a receipt
    Promise.all(relayPromises).then(() => {
      console.log('[FetchZapReceipt] All relay queries completed');
      if (zapReceipt) {
        logInfo('[FetchZapReceipt] ✅ Zap receipt fetched successfully');
        console.log('[FetchZapReceipt] Receipt data:', zapReceipt);
      } else {
        logInfo('[FetchZapReceipt] ❌ No zap receipt found');
        console.log('[FetchZapReceipt] Completed relays:', completedRelays, '/', totalRelays);
      }
      resolve(zapReceipt);
    }).catch((error) => {
      console.error('[FetchZapReceipt] Error in Promise.all:', error);
      resolve(null);
    });

    // Overall timeout after 10 seconds
    setTimeout(() => {
      if (!zapReceipt) {
        console.log('[FetchZapReceipt] Overall timeout reached');
        logWarning('[FetchZapReceipt] Overall timeout');
        resolve(null);
      }
    }, 10000);
  });
}

/**
 * Fetch zap receipts for multiple invoices in batch
 */
export async function fetchZapReceiptsForInvoices(
  invoices: string[]
): Promise<Map<string, {
  senderPubkey: string;
  recipientPubkey: string;
  eventId?: string;
  comment?: string;
}>> {
  const results = new Map();

  // Fetch in parallel (with rate limiting)
  const promises = invoices.map(async (invoice) => {
    const receipt = await fetchZapReceiptForInvoice(invoice);
    if (receipt) {
      results.set(invoice, receipt);
    }
  });

  await Promise.all(promises);

  return results;
}
