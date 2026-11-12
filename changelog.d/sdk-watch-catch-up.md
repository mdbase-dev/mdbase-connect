## Fixed

- SDK: a change watch that starts or resumes more than 1,000 changes behind its cursor now delivers all of them. It read only the first 1,000 and skipped the rest without saying so, so an app that follows the feed could miss changes after a long disconnection.
