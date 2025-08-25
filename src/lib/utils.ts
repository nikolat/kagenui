import type { NostrEvent } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';
import type { RelayRecord } from 'nostr-tools/relay';
import * as nip19 from 'nostr-tools/nip19';

export const getPubkeyFromNpub = (npub: string, enableLog: boolean = true): string | null => {
	let dr;
	try {
		dr = nip19.decode(npub);
	} catch (error) {
		if (enableLog) {
			console.error(error);
		}
		return null;
	}
	let pubkey: string;
	if (dr.type === 'npub') {
		pubkey = dr.data;
	} else if (dr.type === 'nprofile') {
		pubkey = dr.data.pubkey;
	} else {
		if (enableLog) {
			console.error(`${npub} is not npub/nprofile`);
		}
		return null;
	}
	return pubkey;
};

export const getRelaysToUseFromKind10002Event = (event: NostrEvent): RelayRecord => {
	const newRelays: RelayRecord = {};
	for (const tag of event?.tags.filter(
		(tag) => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1])
	) ?? []) {
		const url: string = normalizeURL(tag[1]);
		const isRead: boolean = tag.length === 2 || tag[2] === 'read';
		const isWrite: boolean = tag.length === 2 || tag[2] === 'write';
		if (newRelays[url] === undefined) {
			newRelays[url] = {
				read: isRead,
				write: isWrite
			};
		} else {
			if (isRead) {
				newRelays[url].read = true;
			}
			if (isWrite) {
				newRelays[url].write = true;
			}
		}
	}
	return newRelays;
};

export const getEncrypt = (): ((pubkey: string, plaintext: string) => Promise<string>) | null => {
	if (window.nostr?.nip44?.encrypt !== undefined) {
		return window.nostr.nip44.encrypt;
	} else if (window.nostr?.nip04?.encrypt !== undefined) {
		return window.nostr.nip04.encrypt;
	}
	return null;
};

const getDecrypt = (
	content: string
): ((pubkey: string, ciphertext: string) => Promise<string>) | null => {
	const isNIP04: boolean = content.includes('?iv=');
	if (isNIP04 && window.nostr?.nip04?.decrypt !== undefined) {
		return window.nostr.nip04.decrypt;
	} else if (window.nostr?.nip44?.decrypt !== undefined) {
		return window.nostr.nip44.decrypt;
	}
	return null;
};

export const getBlockedRelays = async (
	event: NostrEvent,
	loginPubkey: string
): Promise<string[]> => {
	const getRelayList = (tags: string[][]): string[] =>
		Array.from(
			new Set<string>(
				tags
					.filter((tag) => tag.length >= 2 && tag[0] === 'relay')
					.map((tag) => normalizeURL(tag[1]))
			)
		);
	const pubRelays: string[] = getRelayList(event.tags);
	let secRelays: string[] = [];
	if (event.content.length > 0) {
		let contentList: string[][] = [];
		const decrypt = getDecrypt(event.content);
		if (decrypt !== null) {
			try {
				const content = await decrypt(loginPubkey, event.content);
				contentList = JSON.parse(content);
			} catch (error) {
				console.warn(error);
			}
		}
		secRelays = getRelayList(contentList);
	}
	return Array.from(new Set<string>([...pubRelays, ...secRelays]));
};

export const getMark = (state: string): string => {
	let mark: string;
	switch (state) {
		case 'connected':
			mark = '🟢';
			break;
		case 'dormant':
			mark = '🔵';
			break;
		case 'error':
		case 'rejected':
			mark = '🔴';
			break;
		case 'connecting':
		case 'retrying':
			mark = '🟡';
			break;
		default:
			mark = '🟣';
			break;
	}
	return mark;
};

export const getStates = (mark: string): string[] | undefined => {
	let states: string[] | undefined;
	switch (mark) {
		case '🟢':
			states = ['connected'];
			break;
		case '🔵':
			states = ['dormant'];
			break;
		case '🔴':
			states = ['error', 'rejected'];
			break;
		case '🟡':
			states = ['connecting', 'retrying'];
			break;
		case '🟣':
			states = ['initialized', 'waiting-for-retrying', 'terminated'];
			break;
		default:
			break;
	}
	return states;
};

export const getCount = (
	mark: string,
	filteredRelays: string[],
	relayState: [string, string][]
): number => {
	const relayStateMap: Map<string, string> = new Map<string, string>(relayState);
	const states: string[] | undefined = getStates(mark);
	let filter: (relay: string) => boolean;
	if (states === undefined) {
		filter = (_relay: string): boolean => false;
	} else {
		filter = (relay: string): boolean => {
			const state: string | undefined = relayStateMap.get(relay);
			if (state === undefined) {
				return mark === '🟣';
			} else {
				return states.includes(state);
			}
		};
	}
	const count = filteredRelays.filter(filter).length;
	return count;
};

export const getRequiredPubkysAndRelays = (
	userPubkeys: [string, string[]][],
	savedRelays: string[],
	blockedRelays: string[],
	deadRelays: string[]
): [[string, string[]][], string[]] => {
	const relaySet: Set<string> = new Set<string>();
	const allPubkeySet: Set<string> = new Set<string>(userPubkeys.map((e) => e[1]).flat());
	const userPubkeysMap: Map<string, Set<string>> = new Map<string, Set<string>>();
	for (const up of userPubkeys) {
		userPubkeysMap.set(up[0], new Set<string>(up[1]));
	}
	for (const relay of savedRelays.filter(
		(r) => r.startsWith('wss://') && !blockedRelays.includes(r) && !deadRelays.includes(r)
	)) {
		const usersUsing: Set<string> = userPubkeysMap.get(relay) ?? new Set<string>();
		if (Array.from(usersUsing).some((p) => allPubkeySet.has(p))) {
			relaySet.add(relay);
			userPubkeysMap.set(
				relay,
				new Set<string>(Array.from(usersUsing).filter((p) => allPubkeySet.has(p)))
			);
			for (const p of usersUsing) {
				allPubkeySet.delete(p);
			}
		}
	}
	const r: [string, string[]][] = [];
	for (const [k, v] of userPubkeysMap) {
		r.push([k, Array.from(v)]);
	}
	return [r, Array.from(relaySet)];
};
