<script lang="ts">
	import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
	import { normalizeURL } from 'nostr-tools/utils';
	import type { RelayRecord } from 'nostr-tools/relay';
	import * as nip19 from 'nostr-tools/nip19';
	import type { Subscription } from 'rxjs';
	import {
		completeOnTimeout,
		createRxBackwardReq,
		createRxForwardReq,
		createRxNostr,
		filterByType,
		latestEach,
		now,
		type AuthPacket,
		type ConnectionStatePacket,
		type EventPacket,
		type LazyFilter,
		type RetryConfig,
		type RxNostr,
		type RxNostrSendOptions,
		type RxNostrUseOptions
	} from 'rx-nostr';
	import { verifier } from '@rx-nostr/crypto';
	import {
		indexerRelays,
		getRoboHashURL,
		linkGitHub,
		linkto,
		profileRelays,
		sitename,
		siteurl
	} from '$lib/config';
	import {
		getCount,
		getMark,
		getPubkeyFromNpub,
		getRelaysToUseFromKind10002Event,
		getRequiredPubkysAndRelays,
		getStates
	} from '$lib/utils';
	import { onMount } from 'svelte';

	type Profile = {
		name?: string;
		display_name?: string;
		picture?: string;
	};
	type RelayType = 'Write' | 'Read';
	type GroupType = 'All' | 'Required';
	let rxNostr: RxNostr;
	let rxNostrPublishOnly: RxNostr;
	let sub: Subscription | undefined;
	let npub: string = $state('');
	let prof: Profile | undefined = $state();
	let savedRelaysWrite: string[] = $state([]);
	let savedRelaysRead: string[] = $state([]);
	let userPubkeysWrite: [string, string[]][] = $state([]);
	let userPubkeysRead: [string, string[]][] = $state([]);
	let profileMap = $state(new Map<string, Profile>());
	let blockedRelays: string[] = $state([]);
	let authRelays: string[] = $state([]);
	let isGettingEvents = $state(false);
	let message = $state('');
	let relayType: RelayType = $state('Write');
	let groupType: GroupType = $state('All');
	let relaysToUse: RelayRecord | undefined = $state();

	const relayStateMap: Map<string, string> = new Map<string, string>();
	let relayState: [string, string][] = $state([]);
	const deadRelays: string[] = $derived(
		relayState.filter((rs) => ['error', 'rejected'].includes(rs[1])).map((rs) => rs[0])
	);
	const callbackConnectionState = (packet: ConnectionStatePacket) => {
		const relay: string = normalizeURL(packet.from);
		relayStateMap.set(relay, packet.state);
		relayState = Array.from(relayStateMap.entries());
	};

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
			.pipe(
				latestEach(({ event }) => `${event.kind}:${event.pubkey}`),
				completeOnTimeout(1000)
			)
			.subscribe({
				next,
				complete
			});
		rxReq.emit(filter);
		rxReq.over();
	};
	const fetchFoward = (
		rxNostr: RxNostr,
		next: (value: EventPacket) => void,
		complete: () => void,
		filter: LazyFilter,
		options?: Partial<RxNostrUseOptions>
	) => {
		const rxReq = createRxForwardReq();
		rxNostr.use(rxReq, options).subscribe({
			next,
			complete
		});
		rxReq.emit(filter);
	};

	const init = (): void => {
		prof = undefined;
		savedRelaysWrite = [];
		savedRelaysRead = [];
		userPubkeysWrite = [];
		userPubkeysRead = [];
		blockedRelays = [];
		relayStateMap.clear();
		relayState = [];
		authRelays = [];
		const retry: RetryConfig = {
			strategy: 'exponential',
			maxCount: 3,
			initialDelay: 1000,
			polite: true
		};
		rxNostr?.dispose();
		rxNostr = createRxNostr({ verifier, retry });
		rxNostr.setDefaultRelays(indexerRelays);
		rxNostr.createConnectionStateObservable().subscribe(callbackConnectionState);
		rxNostr
			.createAllMessageObservable()
			.pipe(filterByType('AUTH'))
			.subscribe(
				(
					e: AuthPacket & {
						type: 'AUTH';
					}
				) => {
					const relay = normalizeURL(e.from);
					if (!authRelays.includes(relay)) {
						authRelays.push(relay);
					}
				}
			);
	};

	const getRelays = async () => {
		init();
		const userPubkeysWriteMap = new Map<string, Set<string>>();
		const userPubkeysReadMap = new Map<string, Set<string>>();
		const targetPubkey: string | null = getPubkeyFromNpub(npub);
		if (targetPubkey === null) {
			return;
		}
		isGettingEvents = true;
		message = 'getting relays...';
		let ev10002: NostrEvent | undefined;
		let ev3: NostrEvent | undefined;
		const ev10002Map = new Map<string, NostrEvent>();
		//自身のリレーリストを取得
		const firstFetch = (): void => {
			const filter: LazyFilter = {
				kinds: [10002],
				authors: [targetPubkey],
				until: now
			};
			fetchEvents(rxNostr, next1, complete1, filter);
		};
		const next1 = (value: EventPacket): void => {
			ev10002 = value.event;
			relaysToUse = getRelaysToUseFromKind10002Event(ev10002);
		};
		//自身のフォローリスト・リレーリスト・ブロックリストを取得
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
				kinds: [3, 10002, 10006],
				authors: [targetPubkey],
				until: now
			};
			fetchEvents(rxNostr, next2, complete2, filter, { relays });
		};
		const next2 = (value: EventPacket): void => {
			switch (value.event.kind) {
				case 3:
					ev3 = value.event;
					break;
				case 10002:
					ev10002 = value.event;
					relaysToUse = getRelaysToUseFromKind10002Event(ev10002);
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
		//フォローイーのリレーリストを取得
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
		const next3 = (value: EventPacket): void => {
			ev10002Map.set(value.event.pubkey, value.event);
		};
		//フォローイーのプロフィールを取得(アイコン表示のため)
		//同時にフォローイーのリレーリストすべてにテキトーなREQを投げて疎通確認
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
		//完了 引き続き自身のフォローリスト・リレーリスト・ブロックリストを取得
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
			prof = profileMap.get(targetPubkey);

			if (relaysToUse === undefined) {
				return;
			}
			const filter: LazyFilter = {
				kinds: [3, 10002, 10006],
				authors: [targetPubkey],
				since: now
			};
			const relays: string[] = Object.entries(relaysToUse)
				.filter((r) => r[1].write)
				.map((r) => r[0]);
			fetchFoward(rxNostr, next2, () => {}, filter, { relays });
		};
		firstFetch();
	};

	onMount(() => {
		rxNostrPublishOnly = createRxNostr({ verifier, authenticator: 'auto' });
		const search = location.search.replace('?', '');
		const searchParams = new URLSearchParams(search);
		let runAuto: boolean = false;
		for (const [k, v] of searchParams) {
			if (['npub', 'nprofile'].includes(k)) {
				npub = v;
			} else if (k === 'run') {
				runAuto = true;
			}
		}
		if (runAuto && npub.length > 0) {
			getRelays();
		}
	});

	const savedRelays: string[] = $derived(
		relayType === 'Write' ? savedRelaysWrite : savedRelaysRead
	);
	const userPubkeys: [string, string[]][] = $derived(
		relayType === 'Write' ? userPubkeysWrite : userPubkeysRead
	);

	const [requiredUserPubkeys, requiredRelays]: [[string, string[]][], string[]] = $derived(
		getRequiredPubkysAndRelays(userPubkeys, savedRelays, blockedRelays, deadRelays)
	);

	const filteredRelays: string[] = $derived(groupType === 'All' ? savedRelays : requiredRelays);
	const filteredPubkeys: [string, string[]][] = $derived(
		groupType === 'All' ? userPubkeys : requiredUserPubkeys
	);

	const removeDeadRelays = async (): Promise<void> => {
		if (relaysToUse === undefined || window.nostr === undefined) {
			return;
		}
		const eventTemplate: EventTemplate = {
			kind: 10002,
			tags: [],
			content: '',
			created_at: now()
		};
		for (const r of Object.entries(relaysToUse)) {
			if (deadRelays.includes(r[0])) {
				continue;
			}
			const tag = ['r', r[0]];
			if (r[1].read && !r[1].write) {
				tag.push('read');
			} else if (!r[1].read && r[1].write) {
				tag.push('write');
			}
			eventTemplate.tags.push(tag);
		}
		const eventToSend = await window.nostr.signEvent(eventTemplate);
		const relaysToUseNew = getRelaysToUseFromKind10002Event(eventToSend);
		const relaysOld: string[] = Object.entries(relaysToUse)
			.filter((r) => r[1].write)
			.map((r) => r[0]);
		const relaysNew: string[] = Object.entries(relaysToUseNew)
			.filter((r) => r[1].write)
			.map((r) => r[0]);
		const relays = Array.from(new Set<string>([...relaysOld, ...relaysNew])).filter(
			(relay) => !blockedRelays.includes(relay)
		);
		const options: Partial<RxNostrSendOptions> | undefined =
			relays.length > 0 ? { on: { relays } } : undefined;
		sendEvent(eventToSend, options);
	};

	const addRelaysToBlockLost = async (relaysToAdd: string[]): Promise<void> => {
		if (relaysToUse === undefined || window.nostr === undefined) {
			return;
		}
		const blockedRelaysForEvent = new Set<string>(blockedRelays);
		for (const relay of relaysToAdd) {
			blockedRelaysForEvent.add(relay);
		}
		const eventTemplate: EventTemplate = {
			kind: 10006,
			tags: Array.from(blockedRelaysForEvent).map((relay) => ['relay', relay]),
			content: '',
			created_at: now()
		};
		const relays: string[] = Object.entries(relaysToUse)
			.filter((r) => r[1].write)
			.map((r) => r[0])
			.filter((relay) => !blockedRelays.includes(relay));
		const options: Partial<RxNostrSendOptions> | undefined =
			relays.length > 0 ? { on: { relays } } : undefined;
		const eventToSend = await window.nostr.signEvent(eventTemplate);
		sendEvent(eventToSend, options);
	};

	const clearBlockList = async (): Promise<void> => {
		if (relaysToUse === undefined || window.nostr === undefined) {
			return;
		}
		const eventTemplate: EventTemplate = {
			kind: 10006,
			tags: [],
			content: '',
			created_at: now()
		};
		const relays: string[] = Object.entries(relaysToUse)
			.filter((r) => r[1].write)
			.map((r) => r[0]);
		const options: Partial<RxNostrSendOptions> | undefined =
			relays.length > 0 ? { on: { relays } } : undefined;
		const eventToSend = await window.nostr.signEvent(eventTemplate);
		sendEvent(eventToSend, options);
	};

	const sendEvent = (eventToSend: NostrEvent, options?: Partial<RxNostrSendOptions>): void => {
		sub?.unsubscribe();
		sub = rxNostrPublishOnly.send(eventToSend, options).subscribe((packet) => {
			const relay = normalizeURL(packet.from);
			const mark = packet.ok ? '🟢' : '🔴';
			console.info(`${mark}${relay}`);
		});
	};
</script>

<svelte:head>
	<meta property="og:title" content={sitename} />
	<meta property="og:type" content="website" />
	<meta property="og:image" content={`${siteurl}ogp.png`} />
	<meta property="og:url" content={siteurl} />
	<link rel="apple-touch-icon" sizes="180x180" href={`${siteurl}apple-touch-icon.png`} />
	<link rel="icon" type="image/png" sizes="16x16" href={`${siteurl}favicon.png`} />
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/dark.css" />
	<title>{sitename}</title>
</svelte:head>

<header><h1>{sitename}</h1></header>
<main>
	<button onclick={getNpubWithNIP07}>get public key from extension</button>
	{#if prof?.picture !== undefined && URL.canParse(prof.picture)}
		<img class="avator_user" src={prof.picture} alt="avator" />
	{/if}
	<input id="npub" type="text" placeholder="npub1... or nprofile1..." bind:value={npub} />
	<button onclick={getRelays} disabled={!npub || isGettingEvents}>show relays of followees</button>
	<p>{message}</p>
	<h2>📶Relay List Metadata (kind:10002)</h2>
	<details>
		<summary>Relay List Metadata</summary>
		<table>
			<tbody>
				<tr>
					<th class="mark"><span title="relay status">📊</span></th>
					<th class="auth"><span title="auth required">✅</span></th>
					<th class="block"><span title="blocked by you">🚫</span></th>
					<th class="url">Relay URL</th>
					<th class="read"><span title="inbox relay">📥</span></th>
					<th class="write"><span title="outbox relay">📝</span></th>
				</tr>
				{#if relaysToUse !== undefined}
					{#each Object.entries(relaysToUse) as relay (relay[0])}
						{@const state = relayState.find((rs) => rs[0] === relay[0])?.at(1) ?? ''}
						<tr>
							<td class="mark"><span title={state}>{getMark(state)}</span></td>
							<td class="auth"
								>{#if authRelays.includes(relay[0])}<span title="auth required">✅</span>{/if}</td
							>
							<td class="block"
								>{#if blockedRelays.includes(relay[0])}<span title="blocked by you">🚫</span
									>{/if}</td
							>
							<td class="url">{relay[0]}</td>
							<td class="read"
								><input type="checkbox" checked={relay[1].read} name="read" disabled /></td
							>
							<td class="write"
								><input type="checkbox" checked={relay[1].write} name="write" disabled /></td
							>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
		<button
			type="button"
			disabled={relaysToUse === undefined ||
				!Object.entries(relaysToUse)
					.map((r) => r[0])
					.some((r) => deadRelays.includes(r))}
			onclick={removeDeadRelays}>Remove dead relays</button
		>
	</details>
	<h2>🚫Blocked Relays (kind:10006)</h2>
	<details>
		<summary>Blocked Relays</summary>
		<h3>Relays blocked</h3>
		<button type="button" disabled={blockedRelays.length === 0} onclick={clearBlockList}
			>Clear block list</button
		>
		<ul class="blocked-relays">
			{#each blockedRelays as relay (relay)}
				{@const state = relayState.find((rs) => rs[0] === relay)?.at(1) ?? ''}
				<li>
					<span title={state}>{getMark(state)}</span>
					{#if authRelays.includes(relay)}<span title="auth required">✅</span>{/if}
					{relay}
				</li>
			{/each}
		</ul>
		<h3>Relays without response</h3>
		<button
			type="button"
			disabled={relaysToUse === undefined || deadRelays.every((r) => blockedRelays.includes(r))}
			onclick={() => addRelaysToBlockLost(deadRelays)}>Add to the block list</button
		>
		<ul class="dead-relays">
			{#each deadRelays.filter((relay) => relay.startsWith('wss://') && !blockedRelays.includes(relay)) as relay (relay)}
				{@const state = relayState.find((rs) => rs[0] === relay)?.at(1) ?? ''}
				<li><span title={state}>{getMark(state)}</span>{relay}</li>
			{/each}
		</ul>
		<h3>Relays for which authentication is requested</h3>
		<button
			type="button"
			disabled={relaysToUse === undefined || authRelays.every((r) => blockedRelays.includes(r))}
			onclick={() => {
				addRelaysToBlockLost(authRelays);
			}}>Add to the block list</button
		>
		<ul class="auth-relays">
			{#each authRelays.filter((relay) => relay.startsWith('wss://') && !blockedRelays.includes(relay)) as relay (relay)}
				<li><span title="auth required">✅</span>{relay}</li>
			{/each}
		</ul>
	</details>
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
	<ul>
		<li>Total: {filteredRelays.length} Relays</li>
		{#each ['🟢', '🔵', '🔴', '🟡', '🟣'] as mark (mark)}
			<li>
				{mark}: {getCount(mark, filteredRelays, relayState)} Relays ({getStates(mark)?.join('/') ??
					''})
			</li>
		{/each}
	</ul>
	<dl>
		{#each filteredRelays as relay (relay)}
			{@const pubkeys = filteredPubkeys.filter(([r]) => r === relay).at(0)}
			{@const state = relayState.find((rs) => rs[0] === relay)?.at(1) ?? ''}
			<dt>
				<span title={state}>{getMark(state)}</span>
				{#if blockedRelays.includes(relay)}<span title="blocked by you">🚫</span>{/if}
				{#if authRelays.includes(relay)}<span title="auth required">✅</span>{/if}
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
	summary {
		width: 100%;
	}
	th {
		text-align: center;
	}
	td:not(.url) {
		text-align: center;
	}
	.mark,
	.auth,
	.block,
	.read,
	.write {
		width: 2em;
	}
	li {
		list-style: none;
	}
	img {
		border-radius: 10%;
	}
	.avator_user {
		width: 36px;
		height: 36px;
		object-fit: cover;
		vertical-align: middle;
	}
	.avatar_relay {
		width: 16px;
		height: 16px;
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
