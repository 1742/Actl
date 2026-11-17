import { tr } from '../../i18n';
import type { AgentToolTimelineBlock } from '../components/conversation/types';
import { agentMailPurposes, agentTaskStates } from '../../../../shared/agent/coordination';

type CardKind = 'roles' | 'agents' | 'plan' | 'tasks' | 'delegate' | 'mail' | 'wait';
type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'error';
type Status = { text: string; tone: Tone };

interface CardRow {
  title: string;
  reference?: string;
  detail?: string | undefined;
  body?: string;
  status?: Status | undefined;
  fields?: Array<{ label: string; value: string }>;
  result?: string;
}

export interface AgentTeamCard {
  kind: CardKind;
  rows: CardRow[];
  empty?: string;
}

const cardKinds = new Map<string, CardKind>([
  ['list_agent_profiles', 'roles'],
  ['agents', 'agents'],
  ['plan', 'plan'],
  ['tasks', 'tasks'],
  ['delegate_task', 'delegate'],
  ['mail', 'mail'],
  ['wait', 'wait'],
]);

export function agentTeamCardKind(name: string) {
  return cardKinds.get(name);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const status = (key: string, tone: Tone = 'neutral'): Status => ({ text: tr(key), tone });
const field = (label: string, value: string) => ({ label: tr(label), value });

export function agentTeamCard(block: AgentToolTimelineBlock, kind: CardKind): AgentTeamCard | undefined {
  const output = block.result?.ok ? block.result.output : undefined;
  const data = record(output);
  const args = record(block.arguments);
  const command = record(args.command);
  let rows: CardRow[];

  switch (kind) {
    case 'roles':
      rows = list(output).map((entry) => {
        const role = record(entry);
        const id = string(role.id);
        const name = string(role.name);
        return { title: name || id, reference: name !== id ? id : '', body: string(role.description) };
      });
      break;
    case 'agents':
      rows = list(output).map((entry) => {
        const agent = record(entry);
        const title = string(agent.title);
        const alias = string(agent.agent);
        return {
          title: title || alias,
          reference: title !== alias && title ? alias : '',
          status: runOrAgentState(string(agent.status)),
          fields: [
            field('agentToolCards.role', string(agent.role)),
            field('agentToolCards.currentTask', string(agent.currentTask)),
          ],
        };
      });
      break;
    case 'plan':
      rows = list(data.items ?? command.items).map((entry) => {
        const item = record(entry);
        const state = string(item.status);
        return {
          title: string(item.text),
          status: state === 'completed' ? status('agentToolCards.planCompleted', 'success')
            : state === 'in_progress' ? status('agents.running', 'active') : undefined,
        } satisfies CardRow;
      });
      break;
    case 'tasks':
      rows = Array.isArray(output)
        ? output.map((task) => taskRow(record(task), false))
        : [taskRow(output === undefined ? command : data, true)];
      break;
    case 'delegate': {
      const task = output === undefined ? args : data;
      const target = record(args.target);
      const owner = string(record(data.attempt).agent);
      const selected = string(target.agent) || string(target.name) || string(target.role);
      const taskStatus = string(data.reason) === 'unassigned'
        ? status('agentToolCards.noMatchingAgent', 'warning') : taskState(data);
      rows = [{
        title: string(task.title) || string(task.task),
        reference: string(task.title) ? string(task.task) : '',
        status: taskStatus,
        fields: [
          field(owner ? 'agents.taskOwner' : 'agentToolCards.target', owner || (output === undefined ? selected : '')),
        ],
      }];
      break;
    }
    case 'mail':
      rows = Array.isArray(output) ? output.map(mailRow) : [mailRow(output === undefined ? command : data)];
      break;
    case 'wait':
      rows = waitRows(data, command);
      break;
  }

  rows = rows.filter((row) => row.title);
  if (rows.length) return { kind, rows };
  return output === undefined ? undefined : { kind, rows, empty: tr(`agentToolCards.empty.${kind}`) };
}

function taskRow(task: Record<string, unknown>, detailed: boolean): CardRow {
  const title = string(task.title);
  const ref = string(task.task);
  const attempt = record(task.attempt);
  const owner = task.status === 'pending' ? '' : string(attempt.agent);
  return {
    title: title || ref,
    reference: title ? ref : '',
    status: taskState(task),
    ...(detailed ? {
      body: string(task.instructions) !== title ? string(task.instructions) : '',
      fields: [
        field('agents.taskOwner', owner),
        field('agents.taskDependencies', list(task.blockedBy).map(string).filter(Boolean).join(', ')),
        field('agents.acceptanceCriteria', string(task.acceptanceCriteria)),
        field('agentToolCards.reason', string(attempt.reason) || string(task.reason)),
      ],
      result: task.status === 'review_required' || task.status === 'completed' ? string(record(attempt.result).output) : '',
    } : { detail: owner }),
  };
}

function taskState(task: Record<string, unknown>): Status | undefined {
  const state = string(task.status);
  if (state === 'pending') {
    if (task.ready === false || task.pendingReason === 'dependencies') return status('agents.taskStatus.blocked', 'warning');
    return status('agentToolCards.pending');
  }
  if (!agentTaskStates.some((known) => known === state)) return undefined;
  const tone = state === 'completed' ? 'success' : state === 'failed' ? 'error'
    : state === 'review_required' ? 'warning' : state === 'assigned' || state === 'running' ? 'active' : 'neutral';
  return status(`agents.taskStatus.${state}`, tone);
}

function mailRow(entry: unknown): CardRow {
  const mail = record(entry);
  const from = string(mail.from);
  const to = string(mail.to);
  const subject = string(mail.subject);
  const reference = string(mail.message);
  const purpose = string(mail.purpose);
  return {
    title: subject || reference || (string(mail.body) ? tr('agentToolCards.reply') : ''),
    reference: subject ? reference : '',
    detail: from && to ? `${from} → ${to}` : from || to,
    body: string(mail.body),
    status: purpose !== 'information' && agentMailPurposes.some((known) => known === purpose)
      ? status(`agents.messagePurpose.${purpose}`, purpose === 'urgent' ? 'warning' : 'neutral') : undefined,
  };
}

function waitRows(data: Record<string, unknown>, command: Record<string, unknown>): CardRow[] {
  const condition = record(data.waitingFor ?? command.condition);
  const detail = waitCondition(condition);
  switch (data.status) {
    case 'matched':
      if (data.kind === 'mail') {
        const mail = mailRow(data);
        return [{ ...mail, status: status('agentToolCards.matched', 'success') }];
      }
      return [{
        title: string(data.task) || string(data.agent) || tr('agentToolCards.runFinished'),
        detail: (data.kind === 'task_state' ? taskState({ status: data.state }) : runOrAgentState(string(data.state)))?.text,
        status: status('agentToolCards.matched', 'success'),
        result: string(data.output),
      }];
    case 'interrupted':
      return [{ title: tr('agentToolCards.interrupted'), detail, status: status('agents.waiting', 'warning') },
        ...list(data.messages).map(mailRow)];
    case 'timed_out': return [{ title: tr('agents.waitTimedOut'), detail }];
    case 'cancelled': return [{ title: tr('agentToolCards.waitCancelled') }];
    case 'no_wait': return [{ title: tr('agentToolCards.noWait') }];
    default: return detail ? [{ title: tr('agents.waiting'), detail }] : [];
  }
}

function waitCondition(condition: Record<string, unknown>): string {
  switch (condition.kind) {
    case 'mail': {
      const replyTo = string(condition.replyTo);
      const from = string(condition.from);
      if (replyTo) return tr('agentToolCards.replyTo', { message: replyTo });
      return from ? tr('agentToolCards.mailFrom', { agent: from }) : tr('agentToolCards.incomingMail');
    }
    case 'task_state': return tr('agentToolCards.taskState', { task: string(condition.task) });
    case 'agent_state': return tr('agentToolCards.agentState', { agent: string(condition.agent) });
    case 'run_finished': return tr('agentToolCards.runFinished');
    default: return '';
  }
}

function runOrAgentState(state: string): Status | undefined {
  switch (state) {
    case 'completed': return status('agents.done', 'success');
    case 'cancelled':
    case 'stopped': return status('agents.cancelled');
    case 'incomplete': return status('agents.failed');
    case 'failed': return status('agents.taskStatus.failed', 'error');
    case 'idle': return status('agentToolCards.idle');
    case 'running': return status('agents.running', 'active');
    case 'waiting': return status('agents.waiting', 'warning');
    case 'waiting_permission': return status('agents.approval', 'warning');
    case 'assigned': return status('agents.taskStatus.assigned', 'active');
  }
}
