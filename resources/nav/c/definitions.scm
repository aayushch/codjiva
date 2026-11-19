(function_declarator declarator: (identifier) @name) @definition.function

(preproc_def name: (identifier) @name) @definition.macro
(preproc_function_def name: (identifier) @name) @definition.macro

(type_definition declarator: (type_identifier) @name) @definition.type
(type_definition declarator: (pointer_declarator declarator: (type_identifier) @name)) @definition.type
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(union_specifier name: (type_identifier) @name body: (_)) @definition.struct
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(enumerator name: (identifier) @name) @definition.enumerator

(field_declaration declarator: (field_identifier) @name) @definition.field
(field_declaration declarator: (pointer_declarator declarator: (field_identifier) @name)) @definition.field
(field_declaration declarator: (array_declarator declarator: (field_identifier) @name)) @definition.field

(declaration
  (type_qualifier)
 
  declarator: (init_declarator declarator: (identifier) @name)) @definition.constant
(declaration declarator: (identifier) @name) @definition.variable
(declaration declarator: (init_declarator declarator: (identifier) @name)) @definition.variable
(declaration declarator: (pointer_declarator declarator: (identifier) @name)) @definition.variable
(declaration
 
  declarator: (init_declarator
    declarator: (pointer_declarator declarator: (identifier) @name))) @definition.variable
(declaration declarator: (array_declarator declarator: (identifier) @name)) @definition.variable
(declaration
 
  declarator: (init_declarator
    declarator: (array_declarator declarator: (identifier) @name))) @definition.variable
