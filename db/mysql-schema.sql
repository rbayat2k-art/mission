CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  full_name VARCHAR(190) NOT NULL,
  mobile VARCHAR(32) NOT NULL UNIQUE,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(128) NOT NULL,
  password_salt VARCHAR(128) NOT NULL,
  role VARCHAR(24) NOT NULL,
  supervisor_id CHAR(36) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  notification_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_users_role_status (role, status),
  INDEX idx_users_supervisor (supervisor_id),
  CONSTRAINT fk_users_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type VARCHAR(60) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  entity_type VARCHAR(80) NULL,
  entity_id CHAR(36) NULL,
  read_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_notifications_user_unread (user_id, read_at, created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash VARCHAR(128) NOT NULL UNIQUE,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  user_agent VARCHAR(500) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  INDEX idx_push_subscriptions_user (user_id),
  CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_sessions_user_expires (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS work_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  status VARCHAR(24) NOT NULL,
  started_at VARCHAR(40) NOT NULL,
  ended_at VARCHAR(40) NULL,
  end_note TEXT NULL,
  start_source VARCHAR(24) NOT NULL DEFAULT 'live',
  end_source VARCHAR(24) NULL,
  work_type VARCHAR(24) NOT NULL DEFAULT 'regular',
  approval_status VARCHAR(24) NOT NULL DEFAULT 'approved',
  score_penalty INT NOT NULL DEFAULT 0,
  created_at VARCHAR(40) NULL,
  INDEX idx_work_sessions_user_status (user_id, status),
  INDEX idx_work_sessions_approval (approval_status, started_at),
  CONSTRAINT fk_work_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS missions (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  source VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL,
  priority VARCHAR(24) NOT NULL DEFAULT 'normal',
  created_by CHAR(36) NOT NULL,
  assigned_to CHAR(36) NOT NULL,
  destination_name VARCHAR(255) NULL,
  result VARCHAR(100) NULL,
  report TEXT NULL,
  expense_amount BIGINT NOT NULL DEFAULT 0,
  score_pending INT NOT NULL DEFAULT 0,
  score_confirmed INT NOT NULL DEFAULT 0,
  score_penalty INT NOT NULL DEFAULT 0,
  score_note VARCHAR(255) NULL,
  deadline VARCHAR(64) NULL,
  deadline_at VARCHAR(40) NULL,
  started_at VARCHAR(40) NULL,
  start_latitude_e6 INT NULL,
  start_longitude_e6 INT NULL,
  start_accuracy_cm INT NULL,
  start_location_recorded_at VARCHAR(40) NULL,
  completed_at VARCHAR(40) NULL,
  end_latitude_e6 INT NULL,
  end_longitude_e6 INT NULL,
  end_accuracy_cm INT NULL,
  end_location_recorded_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_missions_assigned_status (assigned_to, status),
  INDEX idx_missions_source_status (source, status),
  INDEX idx_missions_assigned_completed (assigned_to, completed_at),
  CONSTRAINT fk_missions_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_missions_assignee FOREIGN KEY (assigned_to) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS mission_attempts (
  id CHAR(36) PRIMARY KEY,
  mission_id CHAR(36) NOT NULL,
  attempt_no INT NOT NULL,
  result VARCHAR(100) NOT NULL,
  report TEXT NOT NULL,
  destination_name VARCHAR(255) NULL,
  expense_amount BIGINT NOT NULL DEFAULT 0,
  score_awarded INT NOT NULL DEFAULT 0,
  score_penalty INT NOT NULL DEFAULT 0,
  started_at VARCHAR(40) NULL,
  completed_at VARCHAR(40) NOT NULL,
  start_latitude_e6 INT NULL,
  start_longitude_e6 INT NULL,
  start_accuracy_cm INT NULL,
  start_location_recorded_at VARCHAR(40) NULL,
  destination_latitude_e6 INT NULL,
  destination_longitude_e6 INT NULL,
  destination_accuracy_cm INT NULL,
  destination_recorded_at VARCHAR(40) NULL,
  end_latitude_e6 INT NULL,
  end_longitude_e6 INT NULL,
  end_accuracy_cm INT NULL,
  end_location_recorded_at VARCHAR(40) NULL,
  approval_status VARCHAR(24) NOT NULL DEFAULT 'not_required',
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_mission_attempt_no (mission_id, attempt_no),
  INDEX idx_mission_attempts_mission_completed (mission_id, completed_at),
  INDEX idx_mission_attempts_approval (approval_status, completed_at),
  CONSTRAINT fk_mission_attempts_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS approvals (
  id CHAR(36) PRIMARY KEY,
  mission_id CHAR(36) NOT NULL UNIQUE,
  supervisor_id CHAR(36) NULL,
  status VARCHAR(24) NOT NULL,
  reason TEXT NULL,
  created_at VARCHAR(40) NOT NULL,
  decided_at VARCHAR(40) NULL,
  INDEX idx_approvals_status_created (status, created_at),
  CONSTRAINT fk_approvals_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  CONSTRAINT fk_approvals_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS mission_follow_up_requests (
  id CHAR(36) PRIMARY KEY,
  mission_id CHAR(36) NOT NULL,
  attempt_no INT NULL,
  created_by CHAR(36) NOT NULL,
  supervisor_id CHAR(36) NOT NULL,
  assigned_to CHAR(36) NOT NULL,
  category VARCHAR(60) NOT NULL,
  request_text TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'awaiting_supervisor',
  resolution_note TEXT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  resolved_at VARCHAR(40) NULL,
  INDEX idx_follow_up_mission_status (mission_id, status, created_at),
  INDEX idx_follow_up_assigned_status (assigned_to, status, updated_at),
  INDEX idx_follow_up_supervisor_status (supervisor_id, status, updated_at),
  CONSTRAINT fk_follow_up_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  CONSTRAINT fk_follow_up_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_follow_up_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id),
  CONSTRAINT fk_follow_up_assigned FOREIGN KEY (assigned_to) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS mission_follow_up_messages (
  id CHAR(36) PRIMARY KEY,
  request_id CHAR(36) NOT NULL,
  sender_id CHAR(36) NOT NULL,
  message_type VARCHAR(24) NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_follow_up_messages_request_created (request_id, created_at),
  CONSTRAINT fk_follow_up_message_request FOREIGN KEY (request_id) REFERENCES mission_follow_up_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_follow_up_message_sender FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  actor_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  details LONGTEXT NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_audit_entity_created (entity_type, entity_id, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS location_points (
  id CHAR(36) PRIMARY KEY,
  client_event_id VARCHAR(100) NOT NULL UNIQUE,
  user_id CHAR(36) NOT NULL,
  work_session_id CHAR(36) NOT NULL,
  latitude_e6 INT NOT NULL,
  longitude_e6 INT NOT NULL,
  accuracy_cm INT NOT NULL,
  altitude_cm INT NULL,
  speed_cms INT NULL,
  heading_deg INT NULL,
  recorded_at VARCHAR(40) NOT NULL,
  received_at VARCHAR(40) NOT NULL,
  INDEX idx_location_user_recorded (user_id, recorded_at),
  INDEX idx_location_session_recorded (work_session_id, recorded_at),
  CONSTRAINT fk_locations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_locations_session FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS mission_destinations (
  id CHAR(36) PRIMARY KEY,
  mission_id CHAR(36) NOT NULL UNIQUE,
  user_id CHAR(36) NOT NULL,
  work_session_id CHAR(36) NOT NULL,
  destination_name VARCHAR(255) NOT NULL,
  latitude_e6 INT NOT NULL,
  longitude_e6 INT NOT NULL,
  accuracy_cm INT NOT NULL,
  recorded_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_mission_destinations_user_recorded (user_id, recorded_at),
  INDEX idx_mission_destinations_session_recorded (work_session_id, recorded_at),
  CONSTRAINT fk_mission_destinations_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  CONSTRAINT fk_mission_destinations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mission_destinations_session FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS integrity_events (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  work_session_id CHAR(36) NULL,
  type VARCHAR(60) NOT NULL,
  severity VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  details LONGTEXT NOT NULL,
  occurred_at VARCHAR(40) NOT NULL,
  reviewed_by CHAR(36) NULL,
  reviewed_at VARCHAR(40) NULL,
  review_note TEXT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_integrity_status_created (status, created_at),
  INDEX idx_integrity_user_occurred (user_id, occurred_at),
  CONSTRAINT fk_integrity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_integrity_session FOREIGN KEY (work_session_id) REFERENCES work_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_integrity_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) PRIMARY KEY,
  mission_id CHAR(36) NOT NULL,
  uploaded_by CHAR(36) NOT NULL,
  object_key VARCHAR(255) NOT NULL UNIQUE,
  file_name VARCHAR(190) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  follow_up_message_id CHAR(36) NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX idx_attachments_mission_created (mission_id, created_at),
  INDEX idx_attachments_follow_up_message (follow_up_message_id, created_at),
  CONSTRAINT fk_attachments_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
