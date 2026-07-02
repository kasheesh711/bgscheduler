# Progress Tests ERD

Mechanical table reference for the Progress Tests domain. The domain is
cross-snapshot by design: attendance and cycle state must accumulate across
Credit Control snapshot rotations.

```mermaid
erDiagram
  progress_test_cycle_state ||--o{ progress_test_bookings : has
  progress_test_cycle_state ||--o{ progress_test_email_runs : notifies
  progress_test_cycle_state ||--o{ progress_test_notifications : records
  progress_test_email_runs ||--o{ progress_test_notifications : sends
  progress_test_admin_digest_runs ||--o{ progress_test_admin_digest_recipients : sends

  progress_test_attendance_ledger {
    uuid id PK
    text enrollment_key
    text wise_session_id
    text wise_student_id
    timestamp scheduled_start_time
  }
  progress_test_cycle_state {
    text enrollment_key PK
    text wise_student_id
    text wise_class_id
    int current_count
    progress_test_status status
  }
  progress_test_bookings {
    uuid id PK
    text enrollment_key
    int cycle_index
    progress_test_booking_status status
    boolean dry_run
  }
  progress_test_email_runs {
    uuid id PK
    text enrollment_key
    int cycle_index
    text idempotency_key
  }
  progress_test_notifications {
    uuid id PK
    uuid email_run_id FK
    text enrollment_key
    text idempotency_key
  }
  progress_test_admin_digest_runs {
    uuid id PK
    date digest_date
    text idempotency_key
  }
  progress_test_admin_digest_recipients {
    uuid id PK
    uuid digest_run_id FK
    date digest_date
  }
  progress_test_sync_runs {
    uuid id PK
    sync_status status
    text trigger_type
  }
```

## Tables

| Table | Grain |
|---|---|
| `progress_test_attendance_ledger` | One class/student attendance row that can count toward a progress-test cycle. |
| `progress_test_cycle_state` | One durable cycle state row per enrollment key. |
| `progress_test_bookings` | One progress-test booking or manual-confirmation attempt. |
| `progress_test_email_runs` | One teacher heads-up email run for a cycle. |
| `progress_test_notifications` | One recipient row for a progress-test email run. |
| `progress_test_admin_digest_runs` | One daily admin digest run. |
| `progress_test_admin_digest_recipients` | One recipient row for an admin digest. |
| `progress_test_sync_runs` | One Progress Tests sync/cycle-recompute run. |

_Verified against HEAD + uncommitted WIP on 2026-07-02._
