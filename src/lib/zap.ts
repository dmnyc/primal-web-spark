import { bech32 } from "@scure/base";
import { nip04, nip19, nip47, nip57, Relay, relayInit, utils } from "../lib/nTools";
import { Tier } from "../components/SubscribeToAuthorModal/SubscribeToAuthorModal";
import { Kind } from "../constants";
import { MegaFeedPage, NostrRelaySignedEvent, NostrUserZaps, PrimalArticle, PrimalDVM, PrimalNote, PrimalUser, PrimalZap, TopZap } from "../types/primal";
import { logError } from "./logger";
import { decrypt, enableWebLn, encrypt, sendPayment, signEvent } from "./nostrAPI";
import { decodeNWCUri } from "./wallet";
import { hexToBytes } from "../utils";
// @ts-ignore
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { convertToUser } from "../stores/profile";
import { StreamingData } from "./streaming";

export let lastZapError: string = "";

// Temporary storage for zap requests by payment hash
// We need this because LNURL servers don't reliably embed zap requests in invoice descriptions
const pendingZapRequests = new Map<string, { zapRequest: any, recipientPubkey: string }>();

// LocalStorage key for persistent zap data
const ZAP_DATA_STORAGE_KEY = 'primal_spark_zap_data';

// Save zap data to localStorage
function saveZapData(paymentHash: string, zapData: { zapRequest: any, recipientPubkey: string }) {
  try {
    const existing = JSON.parse(localStorage.getItem(ZAP_DATA_STORAGE_KEY) || '{}');
    existing[paymentHash] = {
      ...zapData,
      timestamp: Date.now(),
    };

    // Clean up old entries (older than 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    Object.keys(existing).forEach(hash => {
      if (existing[hash].timestamp < thirtyDaysAgo) {
        delete existing[hash];
      }
    });

    localStorage.setItem(ZAP_DATA_STORAGE_KEY, JSON.stringify(existing));
  } catch (error) {
    console.warn('[Zap] Failed to save zap data to localStorage:', error);
  }
}

// Get zap data from localStorage
export function getZapData(paymentHash: string): { zapRequest: any, recipientPubkey: string } | null {
  try {
    const existing = JSON.parse(localStorage.getItem(ZAP_DATA_STORAGE_KEY) || '{}');
    return existing[paymentHash] || null;
  } catch (error) {
    return null;
  }
}

export const zapOverBreez = async (invoice: string, recipientPubkey?: string, zapRequest?: any): Promise<boolean> => {
  console.log('[Zap] zapOverBreez called with:', {
    hasInvoice: !!invoice,
    hasRecipientPubkey: !!recipientPubkey,
    hasZapRequest: !!zapRequest,
  });

  try {
    const { breezWallet } = await import('./breezWalletService');

    // Check if wallet is connected
    if (!breezWallet.isConnected()) {
      logError('Breez wallet not connected');
      lastZapError = 'Breez wallet not connected';
      return false;
    }

    // Store zap request data temporarily if we have it
    if (zapRequest && recipientPubkey) {
      console.log('[Zap] Attempting to store zap request data...');
      try {
        // Extract payment hash from invoice to use as key
        const decoded = decodeBolt11(invoice);
        console.log('[Zap] Decoded invoice:', decoded ? 'SUCCESS' : 'FAILED');

        // Extract payment hash from sections array
        const paymentHash = decoded?.sections?.find((s: any) => s.name === 'payment_hash')?.value;
        console.log('[Zap] Extracted payment hash:', paymentHash);

        if (paymentHash) {
          console.log('[Zap] ✓ Storing zap request for payment hash:', paymentHash);
          const zapData = { zapRequest, recipientPubkey };

          // Store in memory
          pendingZapRequests.set(paymentHash, zapData);

          // Store persistently in localStorage
          saveZapData(paymentHash, zapData);
          console.log('[Zap] ✓ Saved to localStorage');

          // Clean up memory after 5 minutes to prevent memory leaks
          // (localStorage persists longer)
          setTimeout(() => {
            pendingZapRequests.delete(paymentHash);
          }, 5 * 60 * 1000);
        } else {
          console.warn('[Zap] No payment hash found in decoded invoice');
        }
      } catch (error) {
        console.warn('[Zap] Failed to parse invoice for payment hash:', error);
      }
    } else {
      console.warn('[Zap] Missing zapRequest or recipientPubkey:', {
        hasZapRequest: !!zapRequest,
        hasRecipientPubkey: !!recipientPubkey,
      });
    }

    // Send payment via Breez SDK
    const paymentInfo = await breezWallet.sendPayment(invoice);

    // If payment succeeded and we have zap data, enrich the payment
    if (paymentInfo.status === 'completed' && paymentInfo.paymentHash) {
      const zapData = pendingZapRequests.get(paymentInfo.paymentHash);
      if (zapData) {
        console.log('[Zap] Enriching completed payment with zap data');
        // Manually enrich the payment info since the description doesn't have the zap request
        paymentInfo.isZap = true;
        paymentInfo.zapSenderPubkey = zapData.zapRequest.pubkey;
        paymentInfo.zapRecipientPubkey = zapData.recipientPubkey;
        paymentInfo.zapComment = zapData.zapRequest.content || '';

        // Extract event ID from tags
        const eTag = zapData.zapRequest.tags?.find((t: string[]) => t[0] === 'e');
        if (eTag && eTag[1]) {
          paymentInfo.zapEventId = eTag[1];
        }

        // Clean up
        pendingZapRequests.delete(paymentInfo.paymentHash);
      }
    }

    // Publish zap receipt if payment succeeded
    if (paymentInfo.status === 'completed' && recipientPubkey) {
      try {
        const { publishZapReceiptForPayment } = await import('./spark/sparkZapReceipt');
        // Note: The SparkWalletContext will also publish receipts automatically
        // This is a fallback for when using breezWallet directly
        logInfo('[Zap] Zap payment completed, receipt handled by SparkWalletContext');
      } catch (error) {
        logWarning('[Zap] Failed to import zap receipt module:', error);
      }
    }

    // Check payment status
    if (paymentInfo.status === 'completed' || paymentInfo.status === 'pending') {
      // Treat pending as success - the payment will complete asynchronously
      // The SparkWalletContext event listener will handle completion events
      return true;
    } else if (paymentInfo.status === 'failed') {
      logError('Breez payment failed:', paymentInfo);
      lastZapError = 'Payment failed';
      return false;
    } else {
      // Unknown status
      logError('Unknown payment status:', paymentInfo);
      lastZapError = 'Unknown payment status';
      return false;
    }
  } catch (error: any) {
    logError('Failed Breez payment: ', error);
    console.error('Failed Breez payment: ', error);
    lastZapError = error?.message || 'Unknown Breez payment error';
    return false;
  }
};

export const zapOverNWC = async (pubkey: string, nwcEnc: string, invoice: string) => {
  let promises: Promise<boolean>[] = [];
  let relays: Relay[] = [];
  let result: boolean = false;
  try {
    const nwc = await decrypt(pubkey, nwcEnc);

    const nwcConfig = decodeNWCUri(nwc);

    const request = await nip47.makeNwcRequestEvent(nwcConfig.pubkey, hexToBytes(nwcConfig.secret), invoice)

    if (nwcConfig.relays.length === 0) return false;

    for (let i = 0; i < nwcConfig.relays.length; i++) {
      const relay = relayInit(nwcConfig.relays[i]);

      promises.push(new Promise(async (resolve) => {
        await relay.connect();

        relays.push(relay);

        const subInfo = relay.subscribe(
          [{ kinds: [13194], authors: [nwcConfig.pubkey] }],
          {
            onevent(event) {
              const nwcInfo = event.content.split(' ');
              if (nwcInfo.includes('pay_invoice')) {

                const subReq = relay.subscribe(
                  [{ kinds: [23195], ids: [request.id] }],
                  {
                    async onevent(eventResponse) {
                      if (!eventResponse.tags.find(t => t[0] === 'e' && t[1] === request.id)) return;

                      const decoded = await nip04.decrypt(hexToBytes(nwcConfig.secret), nwcConfig.pubkey, eventResponse.content);
                      const content = JSON.parse(decoded);

                      if (content.error) {
                        logError('Failed NWC payment: ', content.error);
                        console.error('Failed NWC payment: ', content.error);
                        subReq.close();
                        subInfo.close();
                        resolve(false);
                        return;
                      }

                      subReq.close();
                      subInfo.close();
                      resolve(true);

                    },
                  },
                );

                relay.publish(request);
              }
            },
          },
        );
      }));
    }

    result = await Promise.any(promises);
  }
  catch (e: any) {
    logError('Failed NWC payment init: ', e);
    console.error('Failed NWC payment init: ', e)
    lastZapError = e;
    result = false;
  }

  for (let i = 0; i < relays.length; i++) {
    const relay = relays[i];
    relay.close();
  }

  return result;

};

export const zapNote = async (
  note: PrimalNote,
  sender: string | undefined,
  amount: number,
  comment = '',
  relays: Relay[],
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  console.log('[Zap] zapNote called with walletType:', walletType);

  if (!sender) {
    return false;
  }

  const callback = await getZapEndpoint(note.user);

  if (!callback) {
    return false;
  }

  const sats = Math.round(amount * 1000);

  let payload = {
    profile: note.pubkey,
    event: note.id,
    amount: sats,
    relays: relays.map(r => r.url)
  };

  if (comment.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }

  const zapReq = nip57.makeZapRequest(payload);

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    console.log('[Zap zapNote] About to check walletType. Current value:', walletType);
    console.log('[Zap zapNote] walletType === "breez":', walletType === 'breez');

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      console.log('[Zap zapNote] ✓ Using Breez wallet for zap');
      return await zapOverBreez(pr, note.pubkey, signedEvent);
    }

    console.log('[Zap zapNote] NOT using Breez. Trying NWC or WebLN...');

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      console.log('[Zap zapNote] Using NWC');
      return await zapOverNWC(sender, nwc[1], pr);
    }

    console.log('[Zap zapNote] Using WebLN fallback');
    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return true;
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return false;
  }
}

export const zapArticle = async (
  note: PrimalArticle,
  sender: string | undefined,
  amount: number,
  comment = '',
  relays: Relay[],
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  if (!sender) {
    return false;
  }

  const callback = await getZapEndpoint(note.user);

  if (!callback) {
    return false;
  }

  const a = `${Kind.LongForm}:${note.pubkey}:${(note.msg.tags.find(t => t[0] === 'd') || [])[1]}`;

  const sats = Math.round(amount * 1000);

  let payload = {
    profile: note.pubkey,
    event: note.msg.id,
    amount: sats,
    relays: relays.map(r => r.url)
  };

  if (comment.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }

  const zapReq = nip57.makeZapRequest(payload);

  if (!zapReq.tags.find((t: string[]) => t[0] === 'a' && t[1] === a)) {
    zapReq.tags.push(['a', a]);
  }

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      return await zapOverBreez(pr, note.pubkey, signedEvent);
    }

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      return await zapOverNWC(sender, nwc[1], pr);
    }

    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return true;
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return false;
  }
}

export const zapProfile = async (
  profile: PrimalUser,
  sender: string | undefined,
  amount: number,
  comment = '',
  relays: Relay[],
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  if (!sender || !profile) {
    return false;
  }

  const callback = await getZapEndpoint(profile);

  if (!callback) {
    return false;
  }

  const sats = Math.round(amount * 1000);

  let payload = {
    profile: profile.pubkey,
    amount: sats,
    relays: relays.map(r => r.url)
  };

  if (comment.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }
  const zapReq = nip57.makeZapRequest(payload);

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      return await zapOverBreez(pr, profile.pubkey, signedEvent);
    }

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      return await zapOverNWC(sender, nwc[1], pr);
    }

    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return true;
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return false;
  }
}

export const zapSubscription = async (
  subEvent: NostrRelaySignedEvent,
  recipient: PrimalUser,
  sender: string | undefined,
  relays: Relay[],
  exchangeRate?: Record<string, Record<string, number>>,
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  if (!sender || !recipient) {
    return false;
  }

  const callback = await getZapEndpoint(recipient);

  if (!callback) {
    return false;
  }

  const costTag = subEvent.tags.find(t => t [0] === 'amount');
  if (!costTag) return false;

  let sats = 0;

  if (costTag[2] === 'sats') {
    sats = parseInt(costTag[1]) * 1_000;
  }

  if (costTag[2] === 'msat') {
    sats = parseInt(costTag[1]);
  }

  if (costTag[2] === 'USD' && exchangeRate && exchangeRate['USD']) {
    let usd = parseFloat(costTag[1]);
    sats = Math.ceil(exchangeRate['USD'].sats * usd * 1_000);
  }

  let payload = {
    profile: recipient.pubkey,
    event: subEvent.id,
    amount: sats,
    relays: relays.map(r => r.url)
  };

  if (subEvent.content.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }

  const zapReq = nip57.makeZapRequest(payload);

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      return await zapOverBreez(pr);
    }

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      return await zapOverNWC(sender, nwc[1], pr);
    }

    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return true;
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return false;
  }
}

export const zapDVM = async (
  dvm: PrimalDVM,
  author: PrimalUser,
  sender: string | undefined,
  amount: number,
  comment = '',
  relays: Relay[],
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  if (!sender) {
    return false;
  }

  const callback = await getZapEndpoint(author);

  if (!callback) {
    return false;
  }

  const a = `${Kind.DVM}:${dvm.pubkey}:${dvm.identifier}`;

  const sats = Math.round(amount * 1000);

  let payload = {
    profile: dvm.pubkey,
    event: dvm.id,
    amount: sats,
    relays: relays.map(r => r.url)
  };

  if (comment.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }

  const zapReq = nip57.makeZapRequest(payload);

  if (!zapReq.tags.find((t: string[]) => t[0] === 'a' && t[1] === a)) {
    zapReq.tags.push(['a', a]);
  }

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      return await zapOverBreez(pr);
    }

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      return await zapOverNWC(sender, nwc[1], pr);
    }

    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return true;
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return false;
  }
}

export const zapStream = async (
  stream: StreamingData,
  host: PrimalUser | undefined,
  sender: string | undefined,
  amount: number,
  comment = '',
  relays: Relay[],
  nwc?: string[],
  walletType?: 'nwc' | 'breez' | null,
) => {
  if (!sender || !host) {
    return { success: false };
  }

  const callback = await getZapEndpoint(host);

  if (!callback) {
    return { success: false };
  }

  const a = `${Kind.LiveEvent}:${stream.pubkey}:${stream.id}`;

  const sats = Math.round(amount * 1000);

  let payload = {
    profile: host.pubkey,
    event: stream.event?.id || null,
    amount: sats,
    relays: relays.map(r => r.url),
  };

  if (comment.length > 0) {
    // @ts-ignore
    payload.comment = comment;
  }

  const zapReq = nip57.makeZapRequest(payload);

  if (!zapReq.tags.find((t: string[]) => t[0] === 'a' && t[1] === a)) {
    zapReq.tags.push(['a', a]);
  }

  try {
    const signedEvent = await signEvent(zapReq);

    const event = encodeURIComponent(JSON.stringify(signedEvent));

    const r2 = await (await fetch(`${callback}?amount=${sats}&nostr=${event}`)).json();
    const pr = r2.pr;

    // Use Breez if it's the active wallet type
    if (walletType === 'breez') {
      const success = await zapOverBreez(pr);
      return { success, event: signedEvent };
    }

    // Use NWC if configured
    if (nwc && nwc[1] && nwc[1].length > 0) {
      const success = await zapOverNWC(sender, nwc[1], pr);
      return { success: true, event: signedEvent };
    }

    // Fallback to WebLN
    await enableWebLn();
    await sendPayment(pr);

    return { success: true, event: signEvent };
  } catch (reason) {
    console.error('Failed to zap: ', reason);
    return { sucess: false };
  }
}

export const getZapEndpoint = async (user: PrimalUser): Promise<string | null>  => {
  try {
    let lnurl: string = ''
    let {lud06, lud16} = user;

    if (lud16) {
      let [name, domain] = lud16.split('@')
      lnurl = `https://${domain}/.well-known/lnurlp/${name}`
    }
    else if (lud06) {
      let {words} = bech32.decode(lud06, 1023)
      let data = bech32.fromWords(words)
      lnurl = utils.utf8Decoder.decode(data)
    }
    else {
      return null;
    }

    try {
      let res = await fetch(lnurl)
      let body = await res.json()

      if (body.allowsNostr && body.nostrPubkey) {
        return body.callback;
      }
    }
    catch (e) {
      logError('LNURL: ', lnurl)
      logError('Error fetching lnurl: ', e);
      return null;
    }
  } catch (err) {
    logError('Error zapping: ', err);
    return null;
    /*-*/
  }

  return null;
}

export const canUserReceiveZaps = (user: PrimalUser | undefined) => {
  return !!user && (!!user.lud16 || !!user.lud06);
}

export const convertToZap = (zapContent: NostrUserZaps) => {

  const bolt11 = (zapContent.tags.find(t => t[0] === 'bolt11') || [])[1];
  const zapEvent = JSON.parse((zapContent.tags.find(t => t[0] === 'description') || [])[1] || '{}');
  const senderPubkey = zapEvent.pubkey as string;
  const receiverPubkey = zapEvent.tags.find((t: string[]) => t[0] === 'p')[1] as string;

  let zappedId = '';
  let zappedKind: number = 0;

  // Decode bolt11 to get amount
  let amount = 0;
  try {
    const decoded = decodeBolt11(bolt11);
    const amountMillisats = decoded?.sections?.find((s: any) => s.name === 'amount')?.value;
    amount = amountMillisats ? parseInt(amountMillisats) / 1000 : 0; // Convert from millisats to sats
  } catch (e) {
    console.warn('[convertToZaps] Failed to decode bolt11 amount:', e);
  }

  const zap: PrimalZap = {
    id: zapContent.id,
    message: zapEvent.content || '',
    amount,
    sender: senderPubkey,
    reciver: receiverPubkey,
    created_at: zapContent.created_at,
    zappedId,
    zappedKind,
  };

  return zap;
}
