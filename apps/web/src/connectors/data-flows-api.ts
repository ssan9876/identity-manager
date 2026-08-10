import { authorizedRequest } from '../api/client'
import type { HrRunOutcome, HrSourceKind } from '../hr/api'
import type { ConnectorTarget } from './api'

/**
 * Mirrors `DataFlowMap` and friends (apps/api/src/connectors/data-flows.controller.ts).
 * There is no shared package between the two apps, so — like `ConnectorTarget`
 * in ./api.ts — this copy is maintained BY HAND and must be checked whenever
 * the controller's response shape changes.
 */

export interface DataFlowInbound {
  id: string
  name: string
  kind: HrSourceKind
  enabled: boolean
  /** The upstream's host, not the full URL — the API deliberately does not send the query string. */
  host: string
  lastRunOutcome: HrRunOutcome | null
  lastRunFinishedAt: string | null
  populatesColumns: string[]
}

export interface DataFlowAttribute {
  localKey: string
  label: string | null
  source: 'custom' | 'core'
  remoteName: string
  enabled: boolean
}

export interface DataFlowOutbound {
  target: ConnectorTarget
  configured: boolean
  enabled: boolean
  provisioningMode: 'all_users' | 'entitled_only'
  lastSuccessfulSyncAt: string | null
  carriesUsers: boolean
  attributes: DataFlowAttribute[]
}

export interface DataFlowMap {
  organizationId: string
  organizationName: string
  inbound: DataFlowInbound[]
  outbound: DataFlowOutbound[]
}

export function fetchDataFlows(accessToken: string, organizationId?: string): Promise<DataFlowMap> {
  const query = organizationId === undefined ? '' : `?organizationId=${encodeURIComponent(organizationId)}`
  return authorizedRequest<DataFlowMap>(`/data-flows${query}`, accessToken)
}
