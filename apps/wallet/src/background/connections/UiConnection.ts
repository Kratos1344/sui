// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { BehaviorSubject, filter, switchMap, takeUntil } from 'rxjs';

import { Connection } from './Connection';
import NetworkEnv from '../NetworkEnv';
import {
	getAllSerializedUIAccountSources,
	accountSourcesHandleUIMessage,
} from '../account-sources';
import { accountsHandleUIMessage, getAllSerializedUIAccounts } from '../accounts';
import {
	acceptQredoConnection,
	getUIQredoInfo,
	getUIQredoPendingRequest,
	rejectQredoConnection,
} from '../qredo';
import { doMigration, getStatus } from '../storage-migration';
import { createMessage } from '_messages';
import { type ErrorPayload, isBasePayload } from '_payloads';
import { isSetNetworkPayload, type SetNetworkPayload } from '_payloads/network';
import { isGetPermissionRequests, isPermissionResponse } from '_payloads/permissions';
import { isDisconnectApp } from '_payloads/permissions/DisconnectApp';
import { isGetTransactionRequests } from '_payloads/transactions/ui/GetTransactionRequests';
import { isTransactionRequestResponse } from '_payloads/transactions/ui/TransactionRequestResponse';
import Permissions from '_src/background/Permissions';
import Tabs from '_src/background/Tabs';
import Transactions from '_src/background/Transactions';
import Keyring from '_src/background/keyring';
import { growthbook } from '_src/shared/experimentation/features';
import {
	type MethodPayload,
	isMethodPayload,
	type UIAccessibleEntityType,
} from '_src/shared/messaging/messages/payloads/MethodPayload';
import {
	type QredoConnectPayload,
	isQredoConnectPayload,
} from '_src/shared/messaging/messages/payloads/QredoConnect';

import type { Message } from '_messages';
import type { PortChannelName } from '_messaging/PortChannelName';
import type { LoadedFeaturesPayload } from '_payloads/feature-gating';
import type { Permission, PermissionRequests } from '_payloads/permissions';
import type { UpdateActiveOrigin } from '_payloads/tabs/updateActiveOrigin';
import type { ApprovalRequest } from '_payloads/transactions/ApprovalRequest';
import type { GetTransactionRequestsResponse } from '_payloads/transactions/ui/GetTransactionRequestsResponse';
import type { Runtime } from 'webextension-polyfill';

export class UiConnection extends Connection {
	public static readonly CHANNEL: PortChannelName = 'sui_ui<->background';
	private uiAppInitialized: BehaviorSubject<boolean> = new BehaviorSubject(false);

	constructor(port: Runtime.Port) {
		super(port);
		this.uiAppInitialized
			.pipe(
				filter((init) => init),
				switchMap(() => Tabs.activeOrigin),
				takeUntil(this.onDisconnect),
			)
			.subscribe(({ origin, favIcon }) => {
				this.send(
					createMessage<UpdateActiveOrigin>({
						type: 'update-active-origin',
						origin,
						favIcon,
					}),
				);
			});
	}

	public async notifyEntitiesUpdated(entitiesType: UIAccessibleEntityType) {
		this.send(
			createMessage<MethodPayload<'entitiesUpdated'>>({
				type: 'method-payload',
				method: 'entitiesUpdated',
				args: {
					type: entitiesType,
				},
			}),
		);
	}

	protected async handleMessage(msg: Message) {
		const { payload, id } = msg;
		try {
			if (isGetPermissionRequests(payload)) {
				this.sendPermissions(Object.values(await Permissions.getPermissions()), id);
				// TODO: we should depend on a better message to know if app is initialized
				if (!this.uiAppInitialized.value) {
					this.uiAppInitialized.next(true);
				}
			} else if (isPermissionResponse(payload)) {
				Permissions.handlePermissionResponse(payload);
			} else if (isTransactionRequestResponse(payload)) {
				Transactions.handleMessage(payload);
			} else if (isGetTransactionRequests(payload)) {
				this.sendTransactionRequests(
					Object.values(await Transactions.getTransactionRequests()),
					id,
				);
			} else if (isDisconnectApp(payload)) {
				await Permissions.delete(payload.origin, payload.specificAccounts);
				this.send(createMessage({ type: 'done' }, id));
			} else if (isBasePayload(payload) && payload.type === 'keyring') {
				await Keyring.handleUiMessage(msg, this);
			} else if (isBasePayload(payload) && payload.type === 'get-features') {
				await growthbook.loadFeatures();
				this.send(
					createMessage<LoadedFeaturesPayload>(
						{
							type: 'features-response',
							features: growthbook.getFeatures(),
							attributes: growthbook.getAttributes(),
						},
						id,
					),
				);
			} else if (isBasePayload(payload) && payload.type === 'get-network') {
				this.send(
					createMessage<SetNetworkPayload>(
						{
							type: 'set-network',
							network: await NetworkEnv.getActiveNetwork(),
						},
						id,
					),
				);
			} else if (isSetNetworkPayload(payload)) {
				await NetworkEnv.setActiveNetwork(payload.network);
				this.send(createMessage({ type: 'done' }, id));
			} else if (isQredoConnectPayload(payload, 'getPendingRequest')) {
				this.send(
					createMessage<QredoConnectPayload<'getPendingRequestResponse'>>(
						{
							type: 'qredo-connect',
							method: 'getPendingRequestResponse',
							args: {
								request: await getUIQredoPendingRequest(payload.args.requestID),
							},
						},
						msg.id,
					),
				);
			} else if (isQredoConnectPayload(payload, 'getQredoInfo')) {
				this.send(
					createMessage<QredoConnectPayload<'getQredoInfoResponse'>>(
						{
							type: 'qredo-connect',
							method: 'getQredoInfoResponse',
							args: {
								qredoInfo: await getUIQredoInfo(
									payload.args.qredoID,
									payload.args.refreshAccessToken,
								),
							},
						},
						msg.id,
					),
				);
			} else if (isQredoConnectPayload(payload, 'acceptQredoConnection')) {
				this.send(
					createMessage<QredoConnectPayload<'acceptQredoConnectionResponse'>>(
						{
							type: 'qredo-connect',
							method: 'acceptQredoConnectionResponse',
							args: { accounts: await acceptQredoConnection(payload.args) },
						},
						id,
					),
				);
			} else if (isQredoConnectPayload(payload, 'rejectQredoConnection')) {
				await rejectQredoConnection(payload.args);
				this.send(createMessage({ type: 'done' }, id));
			} else if (isMethodPayload(payload, 'getStoredEntities')) {
				const entities = await this.getUISerializedEntities(payload.args.type);
				this.send(
					createMessage<MethodPayload<'storedEntitiesResponse'>>(
						{
							method: 'storedEntitiesResponse',
							type: 'method-payload',
							args: {
								type: payload.args.type,
								entities,
							},
						},
						msg.id,
					),
				);
			} else if (await accountSourcesHandleUIMessage(msg, this)) {
				return;
			} else if (await accountsHandleUIMessage(msg, this)) {
				return;
			} else if (isMethodPayload(payload, 'getStorageMigrationStatus')) {
				this.send(
					createMessage<MethodPayload<'storageMigrationStatus'>>(
						{
							method: 'storageMigrationStatus',
							type: 'method-payload',
							args: {
								status: await getStatus(),
							},
						},
						id,
					),
				);
			} else if (isMethodPayload(payload, 'doStorageMigration')) {
				await doMigration(payload.args.password);
				this.send(createMessage({ type: 'done' }, id));
			} else {
				throw new Error(
					`Unhandled message ${msg.id}. (${JSON.stringify(
						'error' in payload ? `${payload.code}-${payload.message}` : payload.type,
					)})`,
				);
			}
		} catch (e) {
			this.send(
				createMessage<ErrorPayload>(
					{
						error: true,
						code: -1,
						message: (e as Error).message,
					},
					id,
				),
			);
		}
	}

	private sendPermissions(permissions: Permission[], requestID: string) {
		this.send(
			createMessage<PermissionRequests>(
				{
					type: 'permission-request',
					permissions,
				},
				requestID,
			),
		);
	}

	private sendTransactionRequests(txRequests: ApprovalRequest[], requestID: string) {
		this.send(
			createMessage<GetTransactionRequestsResponse>(
				{
					type: 'get-transaction-requests-response',
					txRequests,
				},
				requestID,
			),
		);
	}

	private getUISerializedEntities(type: UIAccessibleEntityType) {
		switch (type) {
			case 'accounts': {
				return getAllSerializedUIAccounts();
			}
			case 'accountSources': {
				return getAllSerializedUIAccountSources();
			}
			default: {
				throw new Error(`Unknown entity type ${type}`);
			}
		}
	}
}
