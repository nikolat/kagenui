<script lang="ts">
	import type { NostrEvent } from 'nostr-tools/pure';
	import { normalizeURL } from 'nostr-tools/utils';
	import * as nip19 from 'nostr-tools/nip19';
	import {
		createRxBackwardReq,
		createRxNostr,
		latestEach,
		now,
		type ConnectionStatePacket,
		type EventPacket,
		type LazyFilter,
		type RetryConfig,
		type RxNostr,
		type RxNostrUseOptions
	} from 'rx-nostr';
	import { verifier } from '@rx-nostr/crypto';
	import { indexerRelays, getRoboHashURL, linkGitHub, linkto, profileRelays } from '$lib/config';
	import { onMount } from 'svelte';

	type Profile = {
		name?: string;
		display_name?: string;
		picture?: string;
	};
	type RelayType = 'Write' | 'Read';
	type GroupType = 'All' | 'Required';
	let npub: string = $state('');
	let savedRelaysWrite: string[] = $state([]);
	let savedRelaysRead: string[] = $state([]);
	let userPubkeysWrite: [string, string[]][] = $state([]);
	let userPubkeysRead: [string, string[]][] = $state([]);
	let profileMap = $state(new Map<string, Profile>());
	let blockedRelays: string[] = $state([]);
	let deadRelays: string[] = $state([]);
	let isGettingEvents = $state(false);
	let message = $state('');
	let relayType: RelayType = $state('Write');
	let groupType: GroupType = $state('All');

	const getNpubWithNIP07 = async () => {
		const nostr = window.nostr;
		if (nostr?.getPublicKey) {
			try {
				const pubkey = await nostr.getPublicKey();
				npub = nip19.npubEncode(pubkey);
			} catch (error) {
				console.error(error);
			}
		}
	};

	const relayStateMap: Map<string, string> = new Map<string, string>();
	let relayState: [string, string][] = $state([]);
	const callbackConnectionState = (packet: ConnectionStatePacket) => {
		const relay: string = normalizeURL(packet.from);
		relayStateMap.set(relay, packet.state);
		relayState = Array.from(relayStateMap.entries());
		if (['error', 'rejected'].includes(packet.state)) {
			if (!deadRelays.includes(relay)) {
				deadRelays.push(relay);
			}
		} else {
			if (deadRelays.includes(relay)) {
				deadRelays = deadRelays.filter((r) => r !== relay);
			}
		}
	};

	const fetchEvents = (
		rxNostr: RxNostr,
		next: (value: EventPacket) => void,
		complete: () => void,
		filter: LazyFilter,
		options?: Partial<RxNostrUseOptions>
	) => {
		const rxReq = createRxBackwardReq();
		rxNostr
			.use(rxReq, options)
			.pipe(latestEach(({ event }) => `${event.kind}:${event.pubkey}`))
			.subscribe({
				next,
				complete
			});
		rxReq.emit(filter);
		rxReq.over();
	};

	const getRelays = async () => {
		const retry: RetryConfig = {
			strategy: 'exponential',
			maxCount: 3,
			initialDelay: 1000,
			polite: true
		};
		const rxNostr = createRxNostr({ verifier, retry, authenticator: 'auto' });
		rxNostr.setDefaultRelays(indexerRelays);
		rxNostr.createConnectionStateObservable().subscribe(callbackConnectionState);
		savedRelaysWrite = [];
		savedRelaysRead = [];
		userPubkeysWrite = [];
		userPubkeysRead = [];
		blockedRelays = [];
		deadRelays = [];
		const userPubkeysWriteMap = new Map<string, Set<string>>();
		const userPubkeysReadMap = new Map<string, Set<string>>();
		let dr;
		try {
			dr = nip19.decode(npub);
		} catch (error) {
			console.error(error);
			return;
		}
		let pubkey: string;
		if (dr.type === 'npub') {
			pubkey = dr.data;
		} else if (dr.type === 'nprofile') {
			pubkey = dr.data.pubkey;
		} else {
			console.error(`${npub} is not npub/nprofile`);
			return;
		}
		const targetPubkey = pubkey;
		isGettingEvents = true;
		message = 'getting relays...';
		let ev10002: NostrEvent | undefined;
		let ev3: NostrEvent | undefined;
		const ev10002Map = new Map<string, NostrEvent>();
		const next1 = (value: EventPacket): void => {
			ev10002 = value.event;
		};
		const next2 = (value: EventPacket): void => {
			switch (value.event.kind) {
				case 3:
					ev3 = value.event;
					break;
				case 10006:
					blockedRelays = value.event.tags
						.filter((tag) => tag.length >= 2 && tag[0] === 'relay' && URL.canParse(tag[1]))
						.map((tag) => tag[1]);
					break;
				default:
					break;
			}
		};
		const next3 = (value: EventPacket): void => {
			ev10002Map.set(value.event.pubkey, value.event);
		};
		const next4 = (value: EventPacket): void => {
			let profile;
			try {
				profile = JSON.parse(value.event.content);
			} catch (error) {
				console.warn(error);
				return;
			}
			profileMap.set(value.event.pubkey, profile);
		};
		const complete1 = (): void => {
			if (ev10002 === undefined) {
				message = 'kind:10002 event does not exist';
				console.warn(message);
				isGettingEvents = false;
				return;
			}
			const relaySet = new Set<string>();
			for (const tag of ev10002.tags.filter(
				(tag) => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1])
			)) {
				if (tag.length === 2 || tag[2] === 'write') {
					relaySet.add(normalizeURL(tag[1]));
				}
			}
			const relays = Array.from(relaySet);
			console.info('relays:', relays);
			message = `${relays.length} relays`;
			const filter: LazyFilter = {
				kinds: [3, 10006],
				authors: [targetPubkey],
				until: now
			};
			fetchEvents(rxNostr, next2, complete2, filter, { relays });
		};
		const complete2 = (): void => {
			if (ev3 === undefined) {
				message = 'kind:3 event does not exist';
				console.warn(message);
				isGettingEvents = false;
				return;
			}
			const followingPubkeys = ev3.tags
				.filter((tag) => tag.length >= 2 && tag[0] === 'p')
				.map((tag) => tag[1]);
			console.log('followees:', followingPubkeys);
			message = `${followingPubkeys.length} followees`;
			const filter: LazyFilter = {
				kinds: [10002],
				authors: followingPubkeys,
				until: now
			};
			fetchEvents(rxNostr, next3, complete3, filter);
		};
		const complete3 = (): void => {
			for (const [pubkey, event] of ev10002Map) {
				for (const tag of event.tags.filter(
					(tag) => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1])
				)) {
					const url: string = normalizeURL(tag[1]);
					const isWrite: boolean = tag.length === 2 || tag[2] === 'write';
					const isRead: boolean = tag.length === 2 || tag[2] === 'read';
					const userPubkeysArray: Map<string, Set<string>>[] = [];
					if (isWrite) {
						userPubkeysArray.push(userPubkeysWriteMap);
					}
					if (isRead) {
						userPubkeysArray.push(userPubkeysReadMap);
					}
					for (const userPubkeys of userPubkeysArray) {
						let v = userPubkeys.get(url);
						if (v === undefined) {
							v = new Set<string>();
						}
						v.add(pubkey);
						userPubkeys.set(url, v);
					}
				}
			}
			const followingPubkeys = Array.from(ev10002Map.keys());
			const relaysAll: string[] = Array.from(userPubkeysWriteMap.keys());
			message = `profiles of ${followingPubkeys.length} followees fetching...`;
			profileMap.clear();
			const filter: LazyFilter = {
				kinds: [0],
				authors: followingPubkeys,
				until: now
			};
			fetchEvents(rxNostr, next4, complete4, filter, { relays: profileRelays });
			fetchEvents(
				rxNostr,
				(_value: EventPacket) => {},
				() => {},
				{ kinds: [0], authors: [targetPubkey], until: now },
				{ relays: relaysAll }
			);
		};
		const complete4 = (): void => {
			const userPubkeysWriteBase: [string, string[]][] = [];
			const userPubkeysReadBase: [string, string[]][] = [];
			for (const [relay, pubkeySet] of userPubkeysWriteMap) {
				userPubkeysWriteBase.push([relay, Array.from(pubkeySet)]);
			}
			for (const [relay, pubkeySet] of userPubkeysReadMap) {
				userPubkeysReadBase.push([relay, Array.from(pubkeySet)]);
			}
			const compareFn = (a: [string, string[]], b: [string, string[]]) => {
				return b[1].length - a[1].length;
			};
			userPubkeysWrite = userPubkeysWriteBase.toSorted(compareFn);
			userPubkeysRead = userPubkeysReadBase.toSorted(compareFn);
			savedRelaysWrite = userPubkeysWrite.map(([relay]) => relay);
			savedRelaysRead = userPubkeysRead.map(([relay]) => relay);

			isGettingEvents = false;
			message = 'complete';
		};
		const filter: LazyFilter = {
			kinds: [10002],
			authors: [targetPubkey],
			until: now
		};
		fetchEvents(rxNostr, next1, complete1, filter);
	};

	onMount(() => {
		document.addEventListener('nlAuth', (e) => {
			const ce: CustomEvent = e as CustomEvent;
			if (ce.detail.type === 'login' || ce.detail.type === 'signup') {
				npub = nip19.npubEncode(ce.detail.pubkey);
			} else {
				npub = '';
			}
		});
	});

	const savedRelays: string[] = $derived(
		relayType === 'Write' ? savedRelaysWrite : savedRelaysRead
	);
	const userPubkeys: [string, string[]][] = $derived(
		relayType === 'Write' ? userPubkeysWrite : userPubkeysRead
	);

	const [requiredUserPubkeys, requiredRelays]: [[string, string[]][], string[]] = $derived.by(
		() => {
			const relaySet: Set<string> = new Set<string>();
			const allPubkeySet: Set<string> = new Set<string>(userPubkeys.map((e) => e[1]).flat());
			const userPubkeysMap: Map<string, Set<string>> = new Map<string, Set<string>>();
			for (const up of userPubkeys) {
				userPubkeysMap.set(up[0], new Set<string>(up[1]));
			}
			for (const relay of savedRelays.filter(
				(r) => !blockedRelays.includes(r) && !deadRelays.includes(r)
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
		}
	);

	const filteredRelays: string[] = $derived(groupType === 'All' ? savedRelays : requiredRelays);
	const filteredPubkeys: [string, string[]][] = $derived(
		groupType === 'All' ? userPubkeys : requiredUserPubkeys
	);

	const getMark = (state: string): string => {
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
</script>

<svelte:head>
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/dark.css" />
	<title>Nostr Relay Trend</title>
</svelte:head>

<header><h1>Nostr Relay Trend</h1></header>
<main>
	<button onclick={getNpubWithNIP07}>get public key from extension</button>
	<input id="npub" type="text" placeholder="npub1... or nprofile1..." bind:value={npub} />
	<button onclick={getRelays} disabled={!npub || isGettingEvents}>show relays of followees</button>
	<dl>
		<dt>Type</dt>
		<dd>
			<label>
				<input type="radio" bind:group={relayType} name="relaytype" value="Write" />
				Write
			</label>
			<label>
				<input type="radio" bind:group={relayType} name="relaytype" value="Read" />
				Read
			</label>
		</dd>
		<dt>Group</dt>
		<dd>
			<label>
				<input type="radio" bind:group={groupType} name="grouptype" value="All" />
				All
			</label>
			<label>
				<input type="radio" bind:group={groupType} name="grouptype" value="Required" />
				Required
			</label>
		</dd>
	</dl>
	<p>{message}</p>
	<dl>
		{#each filteredRelays as relay (relay)}
			{@const pubkeys = filteredPubkeys.filter(([r]) => r === relay).at(0)}
			{@const state = relayState.find((rs) => rs[0] === relay)?.at(1) ?? ''}
			<dt>
				<span title={state}>{getMark(state)}</span>
				{#if blockedRelays.includes(relay)}<span title="blocked by you">🚫</span>{/if}
				{relay}
			</dt>
			<dd>
				<span>
					{#each pubkeys?.at(1) ?? [] as pubkey (pubkey)}
						{@const prof = profileMap.get(pubkey)}
						{@const name = prof?.name ?? nip19.npubEncode(pubkey).slice(0, 10) + '...'}
						{@const display_name = prof?.display_name ?? ''}
						{@const picture = prof?.picture ?? getRoboHashURL(pubkey)}
						<a href="{linkto}{nip19.npubEncode(pubkey)}" target="_blank" rel="noopener noreferrer"
							><img
								src={picture}
								alt="@{name}"
								title="{display_name} @{name}"
								class="avatar_relay"
							/></a
						>
					{/each}
				</span>
			</dd>
		{/each}
	</dl>
</main>
<footer><a href={linkGitHub} target="_blank" rel="noopener noreferrer">GitHub</a></footer>

<style>
	#npub {
		width: 100%;
	}
	img {
		border-radius: 10%;
	}
	.avatar_relay {
		width: 16px;
		height: 16px;
		border-radius: 10%;
		object-fit: cover;
	}
	dd {
		clear: left;
		white-space: pre-wrap;
		margin-bottom: 1em;
		max-height: 40em;
		overflow-y: auto;
	}
	footer {
		text-align: center;
	}
</style>
