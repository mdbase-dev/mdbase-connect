## Added

- Let native installations request explicit reminder permission for the chosen collection without a legacy OAuth grant. Reuse the existing timer, recovery receipt, sealed channel and notification engines with current installation authority; declining leaves reminders off, and changed permissions require fresh approval without replacing device keys.
