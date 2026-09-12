import assert from 'node:assert/strict'

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function routeFieldsFromConflict(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const record = value as Record<string, unknown>
  assert.equal(record.error_class, 'conflict')
  assert.equal(record.http_status, 409)
  assert.equal(record.reason, 'request_conflict')
  assert.equal(typeof record.next_step, 'string')
  assert.match(String(record.request_id), REQUEST_ID)
  assert.equal(record.front_door_tool, 'front_door')
  assert.equal(record.front_door, 'https://1f3ea.com/')
  assert.equal(record.help_page, 'https://1f3ea.com/help')
  const {
    error_class: _errorClass,
    http_status: _httpStatus,
    reason: _reason,
    next_step: _nextStep,
    request_id: _requestId,
    front_door_tool: _frontDoorTool,
    front_door: _frontDoor,
    help_page: _helpPage,
    ...routeFields
  } = record
  return routeFields
}
