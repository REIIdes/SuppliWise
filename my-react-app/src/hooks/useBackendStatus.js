import { useSyncExternalStore } from 'react';
import {
  getBackendStatus,
  isBackendDown,
  subscribeBackendStatus,
} from '../utils/backendStatus.js';

// Reactive backend reachability: 'up' | 'down' | 'unknown'.
// Components use this to disable actions while the API cannot serve them.
export const useBackendStatus = () =>
  useSyncExternalStore(subscribeBackendStatus, getBackendStatus, () => 'unknown');

export const useBackendOffline = () => useBackendStatus() === 'down';

export { isBackendDown };
