(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class

(class_definition
  body: (block
    (expression_statement
      (assignment left: (identifier) @name) @definition.field)))

((assignment
  left: (attribute object: (identifier) @_self attribute: (identifier) @name)) @definition.field
  (#eq? @_self "self"))

((assignment left: (identifier) @name) @definition.constant
  (#match? @name "^[A-Z][A-Z0-9_]*$"))

(assignment left: (identifier) @name) @definition.variable
(assignment left: (pattern_list (identifier) @name)) @definition.variable

(class_definition
  name: (identifier) @name
  superclasses: (argument_list [(identifier) (attribute) (subscript)] @base))
