/** Load Dependency Source Graphs */

import '@brentbahry/reflection';
import '@brentbahry/util';
import '@proteinjs/serializer';
import '@proteinjs/service';
import 'moment';
import 'uuid';


/** Generate Source Graph */

const sourceGraph = "{\"options\":{\"directed\":true,\"multigraph\":false,\"compound\":false},\"nodes\":[{\"v\":\"@proteinjs/db/DbDriver\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"DbDriver\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/Db.ts\",\"qualifiedName\":\"@proteinjs/db/DbDriver\",\"properties\":[],\"methods\":[{\"name\":\"init\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<void>\",\"filePath\":null,\"qualifiedName\":\"/Promise<void>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"tableExists\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<boolean>\",\"filePath\":null,\"qualifiedName\":\"/Promise<boolean>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"get\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<Row>\",\"filePath\":null,\"qualifiedName\":\"/Promise<Row>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedQuery\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedQuery\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"insert\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<void>\",\"filePath\":null,\"qualifiedName\":\"/Promise<void>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"row\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"Row\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Row\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"update\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"row\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"Row\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Row\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedQuery\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedQuery\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"delete\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedQuery\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedQuery\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"query\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<Row[]>\",\"filePath\":null,\"qualifiedName\":\"/Promise<Row[]>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedQuery\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedQuery\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"sort\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{ column: string, desc?: boolean, byValues?: string[] }[]\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{ column: string, desc?: boolean, byValues?: string[] }[]\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"window\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{ start: number, end: number }\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{ start: number, end: number }\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"getRowCount\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedQuery\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedQuery\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@brentbahry/reflection\",\"name\":\"Loadable\",\"filePath\":null,\"qualifiedName\":\"@brentbahry/reflection/Loadable\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"sourceType\":3}},{\"v\":\"@brentbahry/reflection/Loadable\"},{\"v\":\"@proteinjs/db/Db\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"Db\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/Db.ts\",\"qualifiedName\":\"@proteinjs/db/Db\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"dbDriver\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"DbDriver\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/DbDriver\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":true,\"visibility\":\"private\"},{\"name\":\"logger\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"}],\"methods\":[{\"name\":\"getDbDriver\",\"returnType\":{\"packageName\":\"@proteinjs/db\",\"name\":\"DbDriver\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/DbDriver\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":true,\"visibility\":\"private\",\"parameters\":[]},{\"name\":\"init\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<void>\",\"filePath\":null,\"qualifiedName\":\"/Promise<void>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"tableExists\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<boolean>\",\"filePath\":null,\"qualifiedName\":\"/Promise<boolean>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"get\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"insert\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"Omit<T, keyof Record>\",\"filePath\":null,\"qualifiedName\":\"/Omit<T, keyof Record>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"addDefaultFieldValues\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"any\",\"filePath\":null,\"qualifiedName\":\"/any\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"update\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"Partial<T>\",\"filePath\":null,\"qualifiedName\":\"/Partial<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"addUpdateFieldValues\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"any\",\"filePath\":null,\"qualifiedName\":\"/any\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"delete\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"beforeDelete\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"recordsToDelete\",\"type\":{\"packageName\":\"\",\"name\":\"Record[]\",\"filePath\":null,\"qualifiedName\":\"/Record[]\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"cascadeDeletions\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"deletedRecordIds\",\"type\":{\"packageName\":\"\",\"name\":\"string[]\",\"filePath\":null,\"qualifiedName\":\"/string[]\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"query\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T[]>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T[]>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"sort\",\"type\":{\"packageName\":\"\",\"name\":\"Sort<T>\",\"filePath\":null,\"qualifiedName\":\"/Sort<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"window\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{ start: number, end: number }\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{ start: number, end: number }\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"getRowCount\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"DbService\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/DbService\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/db/DbService\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"DbService\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/services/DbService.ts\",\"qualifiedName\":\"@proteinjs/db/DbService\",\"properties\":[],\"methods\":[{\"name\":\"tableExists\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<boolean>\",\"filePath\":null,\"qualifiedName\":\"/Promise<boolean>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"get\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"insert\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"Omit<T, keyof Record>\",\"filePath\":null,\"qualifiedName\":\"/Omit<T, keyof Record>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"update\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"record\",\"type\":{\"packageName\":\"\",\"name\":\"Partial<T>\",\"filePath\":null,\"qualifiedName\":\"/Partial<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"delete\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"query\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T[]>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T[]>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"sort\",\"type\":{\"packageName\":\"\",\"name\":\"Sort<T>\",\"filePath\":null,\"qualifiedName\":\"/Sort<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"window\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{ start: number, end: number }\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{ start: number, end: number }\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"getRowCount\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":true,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"query\",\"type\":{\"packageName\":\"\",\"name\":\"Query<T>\",\"filePath\":null,\"qualifiedName\":\"/Query<T>\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@proteinjs/service\",\"name\":\"Service\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/service/Service\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"sourceType\":3}},{\"v\":\"/Partial\"},{\"v\":\"/ColumnQuery|SerializedQueryCondition[]\"},{\"v\":\"/ComparisonOperator | 'in'\"},{\"v\":\"/'=' | '>' | '>=' | '\"},{\"v\":\"/AsyncIterable\"},{\"v\":\"@proteinjs/db/Table\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"Table\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/Table.ts\",\"qualifiedName\":\"@proteinjs/db/Table\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"__serializerId\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"name\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"columns\",\"type\":{\"packageName\":\"\",\"name\":\"Columns<T>\",\"filePath\":null,\"qualifiedName\":\"/Columns<T>\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"primaryKey\",\"type\":{\"packageName\":\"\",\"name\":\"(keyof T)[]\",\"filePath\":null,\"qualifiedName\":\"/(keyof T)[]\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"indexes\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{ columns: (keyof T)[], name?: string }[]\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{ columns: (keyof T)[], name?: string }[]\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"cascadeDeleteReferences\",\"type\":{\"packageName\":\"\",\"name\":\"() => { table: string, referenceColumn: string }[]\",\"filePath\":null,\"qualifiedName\":\"/() => { table: string, referenceColumn: string }[]\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"loadRecordsFromSource\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[],\"typeParameters\":[\"/T extends Record\"],\"directParentInterfaces\":[{\"packageName\":\"@brentbahry/reflection\",\"name\":\"Loadable\",\"filePath\":null,\"qualifiedName\":\"@brentbahry/reflection/Loadable\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]},{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializableObject\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializableObject\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/serializer/CustomSerializableObject\"},{\"v\":\"/'integer'\\n\\t| 'bigInteger'\\n\\t| 'text'\\n\\t| 'mediumtext'\\n\\t| 'longtext'\\n\\t| 'string'\\n\\t| 'float'\\n\\t| 'decimal'\\n\\t| 'boolean'\\n\\t| 'date'\\n\\t| 'dateTime'\\n\\t| 'binary'\\n\\t| 'uuid'\"},{\"v\":\"@proteinjs/db/Reference\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"Reference\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/reference/Reference.ts\",\"qualifiedName\":\"@proteinjs/db/Reference\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"__serializerId\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_table\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_id\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":true,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_object\",\"type\":{\"packageName\":\"\",\"name\":\"T\",\"filePath\":null,\"qualifiedName\":\"/T\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":true,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[{\"name\":\"fromObject\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":true,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"object\",\"type\":{\"packageName\":\"\",\"name\":\"T|Omit<T, 'created'|'updated'>\",\"filePath\":null,\"qualifiedName\":\"/T|Omit<T, 'created'|'updated'>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"get\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T|undefined>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T|undefined>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"set\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"object\",\"type\":{\"packageName\":\"\",\"name\":\"T\",\"filePath\":null,\"qualifiedName\":\"/T\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[\"/T extends Record\"],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializableObject\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializableObject\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/db/ReferenceArray\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"ReferenceArray\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/reference/ReferenceArray.ts\",\"qualifiedName\":\"@proteinjs/db/ReferenceArray\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"__serializerId\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_table\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_ids\",\"type\":{\"packageName\":\"\",\"name\":\"string[]\",\"filePath\":null,\"qualifiedName\":\"/string[]\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"_objects\",\"type\":{\"packageName\":\"\",\"name\":\"T[]\",\"filePath\":null,\"qualifiedName\":\"/T[]\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":true,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[{\"name\":\"fromObjects\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":true,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"objects\",\"type\":{\"packageName\":\"\",\"name\":\"(T|Omit<T, 'created'|'updated'>)[]\",\"filePath\":null,\"qualifiedName\":\"/(T|Omit<T, 'created'|'updated'>)[]\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"get\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<T[]>\",\"filePath\":null,\"qualifiedName\":\"/Promise<T[]>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"set\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"objects\",\"type\":{\"packageName\":\"\",\"name\":\"T[]\",\"filePath\":null,\"qualifiedName\":\"/T[]\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[\"/T extends Record\"],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializableObject\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializableObject\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/service/Service\"},{\"v\":\"/DbRecord\"},{\"v\":\"@proteinjs/db/SourceRecordLoader\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SourceRecordLoader\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/source/SourceRecord.ts\",\"qualifiedName\":\"@proteinjs/db/SourceRecordLoader\",\"properties\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<T>\",\"filePath\":null,\"qualifiedName\":\"/Table<T>\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"record\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"{\\n    [P in keyof RequiredProperties<InferRecordWithoutTimestamps<Table<T>>>]: RequiredProperties<InferRecordWithoutTimestamps<Table<T>>>[P];\\n  } & {\\n    [P in keyof OptionalProperties<InferRecordWithoutTimestamps<Table<T>>>]?: OptionalProperties<InferRecordWithoutTimestamps<Table<T>>>[P];\\n  }\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/{\\n    [P in keyof RequiredProperties<InferRecordWithoutTimestamps<Table<T>>>]: RequiredProperties<InferRecordWithoutTimestamps<Table<T>>>[P];\\n  } & {\\n    [P in keyof OptionalProperties<InferRecordWithoutTimestamps<Table<T>>>]?: OptionalProperties<InferRecordWithoutTimestamps<Table<T>>>[P];\\n  }\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[],\"typeParameters\":[\"/T extends SourceRecord\"],\"directParents\":[{\"packageName\":\"@brentbahry/reflection\",\"name\":\"Loadable\",\"filePath\":null,\"qualifiedName\":\"@brentbahry/reflection/Loadable\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"sourceType\":3}},{\"v\":\"@proteinjs/db/ReferenceArraySerializer\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"ReferenceArraySerializer\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/serializers/ReferenceArraySerializer.ts\",\"qualifiedName\":\"@proteinjs/db/ReferenceArraySerializer\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"id\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[{\"name\":\"serialize\",\"returnType\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedReferenceArray\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedReferenceArray\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"referenceArray\",\"type\":{\"packageName\":\"\",\"name\":\"ReferenceArray<any>\",\"filePath\":null,\"qualifiedName\":\"/ReferenceArray<any>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"deserialize\",\"returnType\":{\"packageName\":\"\",\"name\":\"ReferenceArray<any>\",\"filePath\":null,\"qualifiedName\":\"/ReferenceArray<any>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"serializedReferenceArray\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedReferenceArray\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedReferenceArray\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializer\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializer\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/serializer/CustomSerializer\"},{\"v\":\"@proteinjs/db/ReferenceSerializer\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"ReferenceSerializer\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/serializers/ReferenceSerializer.ts\",\"qualifiedName\":\"@proteinjs/db/ReferenceSerializer\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"id\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[{\"name\":\"serialize\",\"returnType\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedReference\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedReference\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"reference\",\"type\":{\"packageName\":\"\",\"name\":\"Reference<any>\",\"filePath\":null,\"qualifiedName\":\"/Reference<any>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"deserialize\",\"returnType\":{\"packageName\":\"\",\"name\":\"Reference<any>\",\"filePath\":null,\"qualifiedName\":\"/Reference<any>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"serializedReference\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedReference\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedReference\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializer\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializer\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/db/TableSerializer\",\"value\":{\"packageName\":\"@proteinjs/db\",\"name\":\"TableSerializer\",\"filePath\":\"/Users/brentbahry/repos/components/db/db/src/serializers/TableSerializer.ts\",\"qualifiedName\":\"@proteinjs/db/TableSerializer\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"id\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[{\"name\":\"serialize\",\"returnType\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedTable\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedTable\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"deserialize\",\"returnType\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"serializedTable\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"SerializedTable\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SerializedTable\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/serializer\",\"name\":\"CustomSerializer\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/serializer/CustomSerializer\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}}],\"edges\":[{\"v\":\"@proteinjs/db/DbDriver\",\"w\":\"@brentbahry/reflection/Loadable\",\"value\":\"extends interface\"},{\"v\":\"@proteinjs/db/Db\",\"w\":\"@proteinjs/db/DbService\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/Table\",\"w\":\"@brentbahry/reflection/Loadable\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/Table\",\"w\":\"@proteinjs/serializer/CustomSerializableObject\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/Reference\",\"w\":\"@proteinjs/serializer/CustomSerializableObject\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/ReferenceArray\",\"w\":\"@proteinjs/serializer/CustomSerializableObject\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/DbService\",\"w\":\"@proteinjs/service/Service\",\"value\":\"extends interface\"},{\"v\":\"@proteinjs/db/SourceRecordLoader\",\"w\":\"@brentbahry/reflection/Loadable\",\"value\":\"extends interface\"},{\"v\":\"@proteinjs/db/ReferenceArraySerializer\",\"w\":\"@proteinjs/serializer/CustomSerializer\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/ReferenceSerializer\",\"w\":\"@proteinjs/serializer/CustomSerializer\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db/TableSerializer\",\"w\":\"@proteinjs/serializer/CustomSerializer\",\"value\":\"implements interface\"}]}";


/** Generate Source Links */

import { Db } from '../src/Db';
import { Table } from '../src/Table';
import { Reference } from '../src/reference/Reference';
import { ReferenceArray } from '../src/reference/ReferenceArray';
import { ReferenceArraySerializer } from '../src/serializers/ReferenceArraySerializer';
import { ReferenceSerializer } from '../src/serializers/ReferenceSerializer';
import { TableSerializer } from '../src/serializers/TableSerializer';

const sourceLinks = {
	'@proteinjs/db/Db': Db,
	'@proteinjs/db/Table': Table,
	'@proteinjs/db/Reference': Reference,
	'@proteinjs/db/ReferenceArray': ReferenceArray,
	'@proteinjs/db/ReferenceArraySerializer': ReferenceArraySerializer,
	'@proteinjs/db/ReferenceSerializer': ReferenceSerializer,
	'@proteinjs/db/TableSerializer': TableSerializer,
};


/** Load Source Graph and Links */

import { SourceRepository } from '@brentbahry/reflection';
SourceRepository.merge(sourceGraph, sourceLinks);


export * from '../index';