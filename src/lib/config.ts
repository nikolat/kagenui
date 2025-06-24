import { npubEncode } from 'nostr-tools/nip19';
import type { WindowNostr } from 'nostr-tools/nip07';

export const sitename = 'KAGENUI';
export const siteurl = 'https://nikolat.github.io/kagenui/';
export const indexerRelays = [
	'wss://directory.yabu.me/',
	'wss://purplepag.es/',
	'wss://indexer.coracle.social/'
];
export const profileRelays = ['wss://directory.yabu.me/'];
export const linkGitHub = 'https://github.com/nikolat/kagenui';
export const linkto = 'https://nostx.io/';
export const getRoboHashURL = (pubkey: string) => {
	return `https://robohash.org/${npubEncode(pubkey)}?set=set4`;
};

declare global {
	interface Window {
		nostr?: WindowNostr;
	}
}
