// This file is part of nbind, copyright (C) 2014-2016 BusFaster Ltd.
// Released under the MIT license, see LICENSE.

import {Binding} from './nbind';
import {SignatureType, removeAccessorPrefix} from './common';
import {
	typeModule,
	TypeFlags,
	TypeSpec,
	TypeSpecWithName,
	TypeClass,
	MakeTypeTbl
} from './Type';

const { Type, makeType, getComplexType } = typeModule(typeModule);

export type BindType = TypeClass;
export const BindType = Type as { new(spec: TypeSpec): TypeClass };

class NBindID {
	constructor(id: number) {
		this.id = id;
	}

	fromJS(output: (id: number) => void) {
		output(this.id);
	}

	toString() {
		return('' + this.id);
	}

	id: number;
}

export class BindClass extends BindType {
	addMethod(name: string, kind: SignatureType, typeList: BindType[], policyList: string[]) {
		const bindMethod = new BindMethod(
			this,
			name,
			typeList[0],
			typeList.slice(1),
			policyList,
			kind == SignatureType.func
		);

		this.methodTbl[name] = bindMethod;
		this.methodList.push(bindMethod);
	}

	addProperty(name: string, kind: SignatureType, typeList: BindType[], policyList: string[]) {
		name = removeAccessorPrefix(name);

		let bindProperty = this.propertyTbl[name];

		if(!bindProperty) {
			bindProperty = new BindProperty(this, name);

			this.propertyTbl[name] = bindProperty;
			this.propertyList.push(bindProperty);
		}

		if(kind == SignatureType.getter) {
			// Property type is getter's return type.
			bindProperty.makeReadable(typeList[0]);
		} else {
			// Property type is type of setter's first argument.
			bindProperty.makeWritable(typeList[1]);
		}
	}

	name: string;

	methodTbl: { [name: string]: BindMethod } = {};
	methodList: BindMethod[] = [];

	propertyTbl: { [name: string]: BindProperty } = {};
	propertyList: BindProperty[] = [];
}

export class BindMethod {
	constructor(
		bindClass: BindClass,
		name: string,
		returnType: BindType,
		argTypeList: BindType[],
		policyList: string[],
		isStatic: boolean
	) {
		this.bindClass = bindClass;
		this.name = name;
		this.returnType = returnType;
		this.argTypeList = argTypeList;
		this.policyList = policyList;
		this.isStatic = isStatic;
	}

	toString() {
		return(
			(
				this.name ?
				this.returnType + ' ' + this.name :
				this.bindClass.name
			) +
			'(' + this.argTypeList.join(', ') + ')'
		);
	}

	bindClass: BindClass;
	name: string;

	returnType: BindType;
	argTypeList: BindType[];

	policyList: string[];

	isStatic: boolean;
}

export class BindProperty {
	constructor(
		bindClass: BindClass,
		name: string
	) {
		this.bindClass = bindClass;
		this.name = name;
	}

	makeReadable(bindType: BindType) {
		this.bindType = bindType;
		this.isReadable = true;
	}

	makeWritable(bindType: BindType) {
		this.bindType = bindType;
		this.isWritable = true;
	}

	toString() {
		return(this.bindType + ' ' + this.name);
	}

	bindClass: BindClass;
	name: string;
	bindType: BindType;

	isReadable = false;
	isWritable = false;
}

const makeTypeTbl: MakeTypeTbl = {
	[TypeFlags.isPrimitive]: BindType,
	[TypeFlags.isBig]: BindType,
	[TypeFlags.isClass]: BindClass,
	[TypeFlags.isClassPtr]: BindType,
	[TypeFlags.isSharedClassPtr]: BindType,
	[TypeFlags.isVector]: BindType,
	[TypeFlags.isArray]: BindType,
	[TypeFlags.isCString]: BindType,
	[TypeFlags.isOther]: BindType
};

export class Reflect {
	constructor(binding: Binding<any>) {
		this.binding = binding;

		// Bind value type on Emscripten target
		// (equivalent Node.js type has no toJS method).
		binding.bind('NBindID', NBindID);

		binding.reflect(
			this.readPrimitive.bind(this),
			this.readType.bind(this),
			this.readClass.bind(this),
			this.readMethod.bind(this)
		);

		function compareName({ name: a }: {name: string}, { name: b }: {name: string}) {
			return(~~(a > b) - ~~(a < b));
		}

		this.classList.sort(compareName);
		this.globalScope.methodList.sort(compareName);
	}

	private readPrimitive(id: number, size: number, flags: number) {
		makeType(this.constructType, {
			flags: TypeFlags.isPrimitive | flags,
			id: id,
			ptrSize: size
		});
	}

	private readType(id: number, name: string) {
		makeType(this.constructType, {
			flags: TypeFlags.isOther,
			id: id,
			name: name
		});
	}

	private readClass(id: number, name: string) {
		const bindClass = makeType(this.constructType, {
			flags: TypeFlags.isClass,
			id: id,
			name: name
		}) as BindClass;

		if(!this.skipNameTbl[bindClass.name]) this.classList.push(bindClass);
	}

	private readMethod(
		classId: number,
		name: string,
		kind: SignatureType,
		typeIdList: number[],
		policyList: string[]
	) {
		let bindClass = this.typeIdTbl[classId] as BindClass;

		if(!bindClass) {
			if(!this.globalScope) {
				bindClass = this.constructType(
					TypeFlags.isClass,
					{flags: TypeFlags.none, id: classId, name: 'global'}
				);

				this.globalScope = bindClass;
			} else {
				throw(new Error('Unknown class ID ' + classId + ' for method ' + name));
			}
		}

		const typeList = typeIdList.map((id: number) => getComplexType(
			id,
			this.constructType,
			this.getType,
			this.queryType,
			'reflect ' + bindClass.name + '.' + name
		));

		switch(kind) {
			case SignatureType.construct:
			case SignatureType.func:
			case SignatureType.method:
				bindClass.addMethod(name, kind, typeList, policyList);
				break;

			case SignatureType.getter:
			case SignatureType.setter:
				bindClass.addProperty(name, kind, typeList, policyList);
				break;

			default:
				break;
		}
	}

	dumpPseudo() {
		const classCodeList: string[] = [];
		let indent: string;
		let staticPrefix: string;

		for(let bindClass of this.classList.concat([this.globalScope])) {
			if((bindClass.flags & TypeFlags.kindMask) == TypeFlags.isClass) {
				indent = '\t';
				staticPrefix = 'static ';
			} else {
				indent = '';
				staticPrefix = '';
			}

			const methodBlock = bindClass.methodList.map((method: BindMethod) => (
				indent +
				(method.name && method.isStatic ? staticPrefix : '') +
				method + ';' +
				(
					method.policyList.length ?
					' // ' + method.policyList.join(', ') :
					''
				)
			)).join('\n');

			const propertyBlock = bindClass.propertyList.map((property: BindProperty) => (
				indent + property + ';' +
				(
					!(property.isReadable && property.isWritable) ?
					' // ' + (property.isReadable ? 'Read-only' : 'Write-only') :
					''
				)
			)).join('\n');

			let classCode = (
				methodBlock +
				(methodBlock && propertyBlock ? '\n\n' : '') +
				propertyBlock
			);

			if(indent) {
				classCode = (
					'class ' + bindClass.name + ' {' +
					(classCode ? '\n' + classCode + '\n' : '') +
					'};'
				);
			}

			classCodeList.push(classCode);
		}

		return(classCodeList.join('\n\n') + '\n');
	}

	private constructType = ((kind: TypeFlags, spec: TypeSpecWithName) => {
		const bindType = new makeTypeTbl[kind](spec as TypeSpecWithName);

		this.typeNameTbl[spec.name] = bindType;
		this.typeIdTbl[spec.id] = bindType;

		return(bindType);
	}).bind(this);

	private getType = ((id: number) => this.typeIdTbl[id]).bind(this);

	private queryType = ((id: number) => {
		let result: {placeholderFlag: number, paramList: number[]} | undefined;

		// TODO: just wrap the call in return() and remove the
		// result variable. Requires support for passing any
		// JavaScript type through C++.

		this.binding.queryType(id, (kind: number, target: number, param: number) => {
			result = {
				paramList: [target, param],
				placeholderFlag: kind
			};
		});

		return(result);
	}).bind(this);

	skipNameTbl: { [key: string]: boolean } = {
		'Int64': true,
		'NBind': true,
		'NBindID': true
	};

	binding: Binding<any>;

	typeIdTbl: { [id: number]: BindType } = {};
	typeNameTbl: { [name: string]: BindType } = {};

	globalScope: BindClass;
	classList: BindClass[] = [];
}
