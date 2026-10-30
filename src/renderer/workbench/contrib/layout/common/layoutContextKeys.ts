// src/renderer/workbench/contrib/layout/common/layoutContextKeys.ts — the global context keys
// the layout code keeps up to date.

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const SidebarVisibleContext = new RawContextKey<boolean>('sidebarVisible', false);
export const PanelVisibleContext = new RawContextKey<boolean>('panelVisible', false);
