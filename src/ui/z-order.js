/**
 * The restack actions, shared by the layer row and the Arrange group.
 *
 * One spec owns the action name, the wording each surface shows, the icon and
 * the direction it sends to `controller.reorder`. The two surfaces used to keep
 * their own literals, so a change to one left the other moving the other way.
 */
export const Z_ORDER_ACTIONS = Object.freeze([
  Object.freeze({ name: 'forward', label: 'Forward', title: 'Bring forward', icon: 'up', delta: 1 }),
  Object.freeze({ name: 'backward', label: 'Backward', title: 'Send backward', icon: 'down', delta: -1 }),
]);
