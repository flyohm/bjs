import {
  Core,
  setStaticProperty,
  setStaticFunction,
} from "./core.js";
import {
  createProxy,
} from "./proxy.js";
import {
  SCOPE_NAME_ATTR,
  SUPER_ATTR,
  EL_ATTR,
} from "./scope_common.js";
import {
  createScope,
} from "./scope.js";
import * as injectors from "./injectors.js";
import * as directives from "./directives.js";
import * as filters from "./filters.js";

/*
 * BJS framework
 */
class Bjs extends Core {
  constructor(doc) {
    super();
    if (!doc) {
      // try document
      doc = document;
    }
    this.doc = doc;
    Core.registerInjector(this.constructor.BIND_ATTR, injectors.injectorBval);
    this.scope = this.createScope();
    this.watchers = this.createWatchers();
    // allow plugins to modify Bjs
    const bPluginEvent = new CustomEvent(this.constructor.PLUGIN_EVENT, { detail: this });
    this.doc.dispatchEvent(bPluginEvent);
    this._templates = this.createTemplates();
    this.evaluateTemplates(this.scope);
    const bReadyEvent = new CustomEvent(this.constructor.READY_EVENT, { detail: this });
    this.doc.dispatchEvent(bReadyEvent);
  }

  createScope(domElement, scope, superScope) {
    const $valueChangedEvent = this.valueChangedEvent.bind(this);
    const realScope = createScope(this, domElement || this.doc, $valueChangedEvent, scope, '', superScope);
    return realScope;
  }

  createWatchers() {
    const $watchers = {};
    return createProxy($watchers, {
      get(target, prop, receiver) {
        if (!(prop in $watchers)) {
          $watchers[prop] = [];
        }
        return $watchers[prop];
      },
    });
  }

  createTemplates() {
    if (this.directives.size == 0) {
      return [];
    }
    const selector = [...this.directives.keys()].map(directive => `* [${directive}]`).join(', ');
    const templates = [];
    for (let elt of [...this.doc.querySelectorAll(selector)].reverse()) {
      const eltCloned = elt.cloneNode(true);
      const template = this.doc.createElement('template');
      template.setAttribute('type', 'bjs');
      for (const directive of this.directives.keys()) {
        if (eltCloned.hasAttribute(directive)) {
          template.setAttribute('directive', directive);
          template.setAttribute('expr', eltCloned.getAttribute(directive));
          eltCloned.removeAttribute(directive);
          break;
        }
      }
      template.content.appendChild(eltCloned);
      elt.replaceWith(template);
      template.nbElts = 0;
      templates.push(template);
    }
    return templates.slice().reverse();
  }

  valueChangedEvent(scope, property, oldValue, newValue) {
    // console.trace(`valueChangedEvent ${scope}`, scope[EL_ATTR], property, oldValue, newValue);
    this.triggerWatchers(scope, property, oldValue, newValue);
    let rootScope = scope;
    while (rootScope[SUPER_ATTR] != null && rootScope[SCOPE_NAME_ATTR]) {
      rootScope = rootScope[SUPER_ATTR];
    }
    this.evaluateTemplates(rootScope);
  }

  triggerWatchers(scope, propertyName, oldValue, newValue) {
    const propertyNames = [propertyName];
    let n = 0;
    const MAX_RECURS = 1000;
    for (let localScope = scope; localScope; localScope = localScope[SUPER_ATTR]) {
      const localPropName = localScope[SCOPE_NAME_ATTR];
      if (localPropName) {
        propertyNames.unshift(localPropName);
      } else {
        break; // loop scope or root scope reached
      }
      n++;
      if (n == MAX_RECURS) {
        console.error(`${MAX_RECURS} recursion reached in scope ${scope} to reach rootScope`);
        return;
      }
    }
    let localScope = scope;
    let localOldValue = oldValue;
    let localNewValue = newValue;
    for (let i = propertyNames.length; i > 0; i--) {
      const fullPropertyName = propertyNames.slice(0, i).join('.');
      const localProperty = propertyNames[i - 1];
      const oldScope = {...localScope};
      oldScope[localProperty] = localOldValue;
      this.watchers[fullPropertyName].forEach(watcher => watcher(localNewValue, localOldValue, localScope, localProperty));
      localOldValue = oldScope;
      localNewValue = localScope;
      localScope = localScope[SUPER_ATTR];
    }
  }

  evaluateTemplates(scope) {
    const connectedTemplates = this._templates.filter(template => template.isConnected);
    console.log(`${connectedTemplates.length} templates connected`);
    for (const template of connectedTemplates) {
      this.evaluateTemplate(template, scope);
    }
    this.applyValues(scope);
    this.findBinds(scope);
  }

  evaluateTemplate(template, scope, nb=1) {
    if (nb == 10) {
      console.log("Max recursion of 10");
      return;
    }
    const directive = template.getAttribute('directive');
    const expr = template.getAttribute('expr');
    if (!directive || !expr) {
      return;
    }
    const func = this.directives.get(directive);
    if (func) {
      const res = func.call(this, scope, template.content.firstChild, expr, template.prevEval, directive);
      template.prevEval = res.varValue;
      console.log(`template ${directive} expr=${expr} will${res.toRender ? '' : ' NOT'} be rendered`);
      console.log(`  ${res.elts.length} DOM elements`);
      if (res.toRender) {
        // remove previously inserted elements
        for (let i = 0; i < template.nbElts; i++) {
          template.nextSibling && template.nextSibling.remove();
        }
      }
      template.nbElts = res.elts.length;
      if (template.nbElts) {
        console.log(`  subelements`, res.elts);
        for (const elt of res.elts) {
          const [element, localScope] = elt;
          // render recursively any sub template of each element
          for (const subTemplate of element.querySelectorAll('template')) {
            if (subTemplate.getAttribute('type') == 'bjs') {
              this.evaluateTemplate(subTemplate, localScope, nb + 1);
            }
          }
        }
        if (res.toRender) {
          console.log(`  adding subelements to the DOM after the template`);
          template.after(...res.elts.map(x => x[0]));
        }
      }
      this.applyValues(scope);
    } else {
      console.error(`function is not defined for directive ${directive}`);
    }
  }

  applyValues(scope) {
    const domElement = scope[EL_ATTR];
    for (const [injector, func] of this.injectors.entries()) {
      if (func) {
        const ownElement = domElement.hasAttribute && domElement.hasAttribute(injector) ? [domElement] : [];
        for (let elt of [...ownElement, ...domElement.querySelectorAll(`* [${injector}]`)]) {
          func.call(this, scope, elt, elt.getAttribute(injector), injector);
        }
      }
    }
  }

  findBinds(scope) {
    const selector = `* [${this.constructor.BIND_ATTR}]`;
    for (let elt of scope[EL_ATTR].querySelectorAll(selector)) {
      const varName = elt.getAttribute(this.constructor.BIND_ATTR)
      if (varName) {
        if (varName.indexOf('.') != -1 || varName.indexOf('[') != -1) {
          throw `${varName} expression is forbidden in ${this.constructor.BIND_ATTR}, you can only use raw variable name`;
        }
        this.addBind(scope, elt, varName);
      }
    }
  }

  addBind(scope, elt, varName) {
    elt.bKeyupEvent = function(event) {
      this.scope[this.name] = this.b.getBindValue(this.elt);
    }.bind({
      b: this,
      name: varName,
      elt: elt,
      scope: scope || this.scope,
    });
    elt.addEventListener('keyup', elt.bKeyupEvent);
    elt.bKeyupEvent();
  }

  getBindValue(elt) {
    if (elt) {
      if (elt.type) {
        return elt.value
      } else {
        return elt.innerText
      }
    }
  }
}

/* static properties and methods */
setStaticProperty(Bjs, 'PLUGIN_EVENT', 'bplugin');
setStaticProperty(Bjs, 'READY_EVENT', 'bready');
setStaticProperty(Bjs, 'BLOAD_ATTR', 'bload');
setStaticProperty(Bjs, 'BIND_ATTR', 'bbind');

setStaticFunction(Bjs, 'getCssDirectivesRule', function() {
  return Core.directives.size ? ([...Core.directives.keys()].map(bdir => `* [${bdir}]`).join(', ') + '{ display: none; }') : '';
});

setStaticFunction(Bjs, 'load', function(doc, cb) {
  const b = new this(doc);
  if (cb && typeof cb == 'function') {
    cb(b);
  }
});

const isBrowser = new Function("try{return this===window;}catch(e){return false;}");
const isNode = new Function("try{return this===global;}catch(e){return false;}");

if (isBrowser && isNode) {
  if (isBrowser) {
    window.Bjs = Bjs;
    const cssDirectives = Bjs.getCssDirectivesRule();
    if (cssDirectives) {
      const bcss = document.createElement('style');
      bcss.type = 'text/css'
      bcss.rel = 'stylesheet'
      document.head.appendChild(bcss);
      bcss.sheet.insertRule(Bjs.getCssDirectivesRule(), 0);
    }
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body.hasAttribute(Bjs.BLOAD_ATTR)) {
        document.body.removeAttribute(Bjs.BLOAD_ATTR);
        Bjs.load(document);
      }
    });
  } else if (isNode) {
    global.Bjs = Bjs;
  }
}

export default Bjs;
