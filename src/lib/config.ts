import { npubEncode } from 'nostr-tools/nip19';
import type { WindowNostr } from 'nostr-tools/nip07';

export const defaultRelays = ['wss://directory.yabu.me/', 'wss://purplepag.es/'];
export const linkGitHub = 'https://github.com/nikolat/nostr-relay-trend';
export const linkto = 'https://nostx.io/';
export const getRoboHashURL = (pubkey: string) => {
	return `https://robohash.org/${npubEncode(pubkey)}?set=set4`;
};

declare global {
	interface Window {
		nostr?: WindowNostr;
	}
}
