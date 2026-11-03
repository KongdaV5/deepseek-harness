/** Runtime constructors for task-domain branded identities. */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TaskId as TaskIdType, TaskOutputId as TaskOutputIdType, TaskStepId as TaskStepIdType } from './types.ts'

function requireIdentity(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) throw new TypeError(`${label} must be a non-empty normalized string`)
  return value
}

/**
 * Brand one validated stable task identity.
 * @param value - normalized non-empty external identity.
 * @returns branded Task identity.
 */
export function taskIdFromString(value: string): TaskIdType {
  return brandString<TaskIdType>(requireIdentity(value, 'task id'))
}

/**
 * Brand one validated task-step identity.
 * @param value - normalized non-empty external identity.
 * @returns branded Task-step identity.
 */
export function taskStepIdFromString(value: string): TaskStepIdType {
  return brandString<TaskStepIdType>(requireIdentity(value, 'task step id'))
}

/**
 * Brand one validated task-output identity.
 * @param value - normalized non-empty external identity.
 * @returns branded Task-output identity.
 */
export function taskOutputIdFromString(value: string): TaskOutputIdType {
  return brandString<TaskOutputIdType>(requireIdentity(value, 'task output id'))
}

/**
 * Generate a collision-resistant stable task identity.
 * @returns generated branded Task identity.
 */
export function createTaskId(): TaskIdType {
  return taskIdFromString(`task-${randomUUID()}`)
}

/**
 * Generate a collision-resistant stable task-output identity.
 * @returns generated branded Task-output identity.
 */
export function createTaskOutputId(): TaskOutputIdType {
  return taskOutputIdFromString(`task-output-${randomUUID()}`)
}
