(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(annotation_type_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field
(constant_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.constant
(enum_constant name: (identifier) @name) @definition.enumerator

(class_declaration name: (identifier) @name (superclass (_) @base))
(class_declaration name: (identifier) @name (super_interfaces (type_list (_) @base)))
(enum_declaration name: (identifier) @name (super_interfaces (type_list (_) @base)))
(record_declaration name: (identifier) @name (super_interfaces (type_list (_) @base)))
(interface_declaration name: (identifier) @name (extends_interfaces (type_list (_) @base)))
