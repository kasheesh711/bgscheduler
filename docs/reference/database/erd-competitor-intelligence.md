# Competitor Intelligence ERD

Mechanical table reference for the Competitor Intelligence domain. The current
handbook has no feature page for this area yet; this page exists so the database
reference has a real home for the 16 persisted tables already defined in
[`src/lib/db/schema.ts`](../../../src/lib/db/schema.ts).

The domain is snapshot-independent. It tracks configured entities/sources, provider
sync runs, captured evidence, generated briefs/snapshots, task suggestions/tasks, and
provider usage.

```mermaid
erDiagram
  competitor_entities ||--o{ competitor_sources : has
  competitor_entities ||--o{ competitor_evidence_items : captures
  competitor_entities ||--o{ competitor_serp_observations : appears_in
  competitor_sync_runs ||--o{ competitor_source_runs : contains
  competitor_sync_runs ||--o{ competitor_ai_runs : summarizes
  competitor_source_runs ||--o{ competitor_evidence_items : produced
  competitor_source_runs ||--o{ competitor_serp_observations : produced
  competitor_evidence_items ||--o{ competitor_assets : has
  competitor_evidence_items ||--o{ competitor_task_suggestions : suggests
  competitor_evidence_items ||--o{ competitor_tasks : drives
  competitor_serp_keywords ||--o{ competitor_serp_observations : observes
  competitor_ai_runs ||--o{ competitor_briefs : writes
  competitor_ai_runs ||--o{ competitor_war_room_snapshots : writes
  competitor_ai_runs ||--o{ competitor_task_suggestions : suggests
  competitor_briefs ||--o{ competitor_task_suggestions : contains
  competitor_briefs ||--o{ competitor_tasks : groups
  competitor_task_suggestions ||--o| competitor_tasks : accepted_as
  competitor_tasks ||--o{ competitor_task_comments : has
  competitor_tasks ||--o{ competitor_task_events : audits

  competitor_entities {
    uuid id PK
    text entity_key
    competitor_entity_kind kind
    text display_name
  }
  competitor_sources {
    uuid id PK
    uuid entity_id FK
    competitor_source_type source_type
    competitor_source_status status
  }
  competitor_sync_runs {
    uuid id PK
    competitor_sync_trigger trigger_type
    sync_status status
  }
  competitor_source_runs {
    uuid id PK
    uuid sync_run_id FK
    uuid source_id FK
    sync_status status
  }
  competitor_evidence_items {
    uuid id PK
    text item_key
    uuid entity_id FK
    uuid source_run_id FK
  }
  competitor_assets {
    uuid id PK
    uuid item_id FK
    text storage_key
  }
  competitor_serp_keywords {
    uuid id PK
    text keyword
    competitor_source_status status
  }
  competitor_serp_observations {
    uuid id PK
    text observation_key
    uuid keyword_id FK
    uuid entity_id FK
  }
  competitor_ai_runs {
    uuid id PK
    uuid sync_run_id FK
    text run_type
    sync_status status
  }
  competitor_briefs {
    uuid id PK
    date brief_date
    uuid sync_run_id FK
    uuid ai_run_id FK
  }
  competitor_war_room_snapshots {
    uuid id PK
    date week_start
    uuid sync_run_id FK
    uuid ai_run_id FK
  }
  competitor_task_suggestions {
    uuid id PK
    uuid brief_id FK
    uuid item_id FK
    uuid ai_run_id FK
  }
  competitor_tasks {
    uuid id PK
    uuid item_id FK
    uuid brief_id FK
    competitor_task_status status
  }
  competitor_task_comments {
    uuid id PK
    uuid task_id FK
  }
  competitor_task_events {
    uuid id PK
    uuid task_id FK
  }
  competitor_vendor_usage {
    uuid id PK
    date usage_month
    text provider
    competitor_source_type source_type
  }
```

## Tables

| Table | Grain |
|---|---|
| `competitor_entities` | One tracked competitor or own-brand entity. |
| `competitor_sources` | One configured website/social/SERP/manual source for an entity. |
| `competitor_sync_runs` | One cron/manual/backfill sync run. |
| `competitor_source_runs` | One provider execution for a source inside a sync run. |
| `competitor_evidence_items` | One captured evidence item, deduped by `item_key`. |
| `competitor_assets` | One stored media/attachment asset for an evidence item. |
| `competitor_serp_keywords` | One tracked keyword/language/location/device tuple. |
| `competitor_serp_observations` | One observed SERP result row. |
| `competitor_ai_runs` | One AI summarization/classification run. |
| `competitor_briefs` | One daily competitor brief. |
| `competitor_war_room_snapshots` | One weekly war-room snapshot. |
| `competitor_task_suggestions` | One suggested response task. |
| `competitor_tasks` | One accepted/manual response task. |
| `competitor_task_comments` | One comment/attachment entry on a task. |
| `competitor_task_events` | One audit event on a task. |
| `competitor_vendor_usage` | One monthly provider/source-type usage ledger row. |

_Verified against HEAD + uncommitted WIP on 2026-07-02._
