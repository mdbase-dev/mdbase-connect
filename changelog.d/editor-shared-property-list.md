## Changed

- The Editor's Fields panel uses the property list shared with other mdbase apps. Each field is a row with its name beside the control its value calls for: chips for tags, a switch, a date picker, a date and time, a choice, or links to other notes as chips with a picker. Empty fields stay out of the way until asked for, and a field is added by typing its name.
- Values with parts of their own (objects, and lists of them) are edited part by part under the field's name, fold away, and take new parts and items from the field's row.
- A required field always has a row, marked with an asterisk, and what is wrong with a value is said under it. A value that is not what the type says is put right by retyping it in the field; the Advanced tab still edits the raw values.
- A field that is cleared leaves the file, where the old editor could leave it as `null`. Values the note's type provides are listed under Automatic, read-only.
