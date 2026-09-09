package ir.taprasystem.employee;

/** Immutable identity for asynchronous work; a stopped/replaced run stays invalid. */
final class TrackingRequestScope {
    static final class Snapshot {
        final String userId;
        final String workSessionId;

        Snapshot(String userId, String workSessionId) {
            this.userId = userId;
            this.workSessionId = workSessionId;
        }
    }

    private Snapshot current;

    synchronized void start(String userId, String workSessionId) {
        if (current == null || !current.userId.equals(userId) ||
            !current.workSessionId.equals(workSessionId)) {
            current = new Snapshot(userId, workSessionId);
        }
    }

    synchronized Snapshot capture() { return current; }

    synchronized boolean isCurrent(Snapshot snapshot, String activeUserId) {
        return snapshot != null && snapshot == current && snapshot.userId.equals(activeUserId);
    }

    synchronized void invalidate() { current = null; }
}
