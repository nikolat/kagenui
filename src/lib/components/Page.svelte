<script lang="ts">
	import { NostrFetcher, type NostrEventWithAuthor } from 'nostr-fetch';
	import type { NostrEvent } from 'nostr-tools/pure';
	import { normalizeURL } from 'nostr-tools/utils';
	import * as nip19 from 'nostr-tools/nip19';
	import { defaultRelays, getRoboHashURL, linkGitHub, linkto } from '$lib/config';
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
	let profiles = $state(new Map<string, Profile>());
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

	const getRelays = async () => {
		savedRelaysWrite = [];
		savedRelaysRead = [];
		userPubkeysWrite = [];
		userPubkeysRead = [];
		const userPubkeysWriteMap = $state(new Map<string, Set<string>>());
		const userPubkeysReadMap = $state(new Map<string, Set<string>>());
		let dr;
		try {
			dr = nip19.decode(npub);
		} catch (error) {
			console.error(error);
			return;
		}
		let pubkey: string;
		let relaySet = new Set<string>(defaultRelays);
		if (dr.type === 'npub') {
			pubkey = dr.data;
		} else if (dr.type === 'nprofile') {
			pubkey = dr.data.pubkey;
			if (dr.data.relays !== undefined) {
				for (const relay of dr.data.relays) relaySet.add(normalizeURL(relay));
			}
		} else {
			console.error(`${npub} is not npub/nprofile`);
			return;
		}
		const targetPubkey = pubkey;
		isGettingEvents = true;
		message = 'getting relays...';
		const fetcher = NostrFetcher.init();
		const ev10002: NostrEvent | undefined = await fetcher.fetchLastEvent(Array.from(relaySet), {
			kinds: [10002],
			authors: [targetPubkey]
		});
		if (ev10002 !== undefined) {
			for (const tag of ev10002.tags.filter(
				(tag) => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1])
			)) {
				if (tag.length === 2 || tag[2] === 'read') {
					relaySet.add(normalizeURL(tag[1]));
				}
			}
		}
		const relays = Array.from(relaySet);
		console.log('relays:', relays);
		message = `${relays.length} relays`;
		const ev3: NostrEvent | undefined = await fetcher.fetchLastEvent(relays, {
			kinds: [3],
			authors: [targetPubkey]
		});
		if (ev3 === undefined) {
			console.warn('followees is 0');
			isGettingEvents = false;
			return;
		}
		const followingPubkeys = ev3.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]);
		console.log('followees:', followingPubkeys);
		message = `${followingPubkeys.length} followees`;
		const ev10002PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: followingPubkeys,
				relayUrls: defaultRelays
			},
			{ kinds: [10002] }
		);
		await setUserPubkeys(ev10002PerAuthor, userPubkeysWriteMap, userPubkeysReadMap);
		message = `profiles of ${followingPubkeys.length} followees fetching...`;
		profiles.clear();
		await setProfiles(fetcher, relays, followingPubkeys, profiles);

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

	const setUserPubkeys = async (
		itr: AsyncIterable<NostrEventWithAuthor<false>>,
		userPubkeysWriteMap: Map<string, Set<string>>,
		userPubkeysReadMap: Map<string, Set<string>>
	): Promise<void> => {
		for await (const { author, event } of itr) {
			if (event === undefined) {
				continue;
			}
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
					v.add(author);
					userPubkeys.set(url, v);
				}
			}
		}
	};

	const setProfiles = async (
		fetcher: NostrFetcher,
		relays: string[],
		pubkeys: string[],
		profiles: Map<string, Profile>
	): Promise<void> => {
		const ev0PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: pubkeys,
				relayUrls: relays
			},
			{ kinds: [0] }
		);
		for await (const { author, event } of ev0PerAuthor) {
			if (event === undefined) {
				continue;
			}
			let profile;
			try {
				profile = JSON.parse(event.content);
			} catch (error) {
				console.warn(error);
				continue;
			}
			profiles.set(author, profile);
		}
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
			for (const relay of savedRelays) {
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
			<dt>{relay}</dt>
			<dd>
				<span>
					{#each pubkeys?.at(1) ?? [] as pubkey (pubkey)}
						{@const prof = profiles.get(pubkey)}
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
