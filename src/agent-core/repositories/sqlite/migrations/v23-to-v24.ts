import type { DatabaseSync } from 'node:sqlite';

export function removeAgentMail(database: DatabaseSync): void {
  database.exec(`
    CREATE TEMP TABLE removed_mail_items(run_id TEXT, item_order INTEGER, PRIMARY KEY(run_id, item_order)) WITHOUT ROWID;

    INSERT INTO removed_mail_items
      SELECT item.run_id, item.item_order FROM timeline_items item
      WHERE item.item_type = 'message' AND (
        json_extract(item.payload_json, '$.source.kind') = 'mail' OR EXISTS (
          SELECT 1 FROM agent_messages m JOIN sessions s ON s.id = m.from_session_id
          JOIN agent_runs r ON r.session_id = m.to_session_id
          WHERE m.id = item.item_id AND r.id = item.run_id AND (
            m.kind = 'result' OR (m.relationship IS NULL AND s.parent_session_id = m.to_session_id)
          )
        )
      );

    -- Only remove complete tool call pairs. Pending approval batches refer to unresolved calls.
    WITH mail_calls AS (
      SELECT run_id, item_order, json_extract(payload_json, '$.callId') AS call_id
      FROM timeline_items WHERE item_type = 'tool_call' AND (
        json_extract(payload_json, '$.name') IN ('send_mail', 'list_mail', 'read_mail', 'wait_for_mail') OR (
          json_extract(payload_json, '$.name') = 'wait_agents' AND
          CASE WHEN json_valid(payload_json ->> '$.argumentsJson')
            THEN json_extract(payload_json ->> '$.argumentsJson', '$.mode') END = 'mail'
        )
      )
    ), pairs AS MATERIALIZED (
      SELECT call.run_id, call.item_order AS call_order, result.item_order AS result_order
      FROM mail_calls call JOIN timeline_items result ON result.run_id = call.run_id
      WHERE result.item_type = 'tool_result' AND json_extract(result.payload_json, '$.callId') = call.call_id
    )
    INSERT INTO removed_mail_items
      SELECT run_id, call_order FROM pairs UNION SELECT run_id, result_order FROM pairs;

    DELETE FROM timeline_items WHERE (run_id, item_order) IN (SELECT run_id, item_order FROM removed_mail_items);

    -- Timeline writes address items by array index. Compact orders via negative values to avoid collisions.
    WITH orders AS MATERIALIZED (
      SELECT run_id, item_order, -row_number() OVER (PARTITION BY run_id ORDER BY item_order) AS temporary_order
      FROM timeline_items WHERE run_id IN (SELECT run_id FROM removed_mail_items)
    )
    UPDATE timeline_items AS item SET item_order = orders.temporary_order FROM orders
      WHERE item.run_id = orders.run_id AND item.item_order = orders.item_order;
    UPDATE timeline_items SET item_order = -item_order - 1 WHERE item_order < 0
      AND run_id IN (SELECT run_id FROM removed_mail_items);

    DROP TABLE removed_mail_items;
    DELETE FROM agent_messages WHERE kind = 'result' OR (relationship IS NULL AND EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = agent_messages.from_session_id AND s.parent_session_id = agent_messages.to_session_id
    ));
    DROP TABLE IF EXISTS agent_mail;
  `);
}
