# TypeScript Strict Mode - Type Error Fixing Plan

## Overview
After enabling full TypeScript strict mode, the codebase has **748 type errors**. This document outlines a strategy for addressing these errors systematically.

## Error Categories

### 1. Import Path Extensions (~150 errors)
- **Issue**: Import paths ending with `.ts` extension
- **Solution**: Already fixed by adding `allowImportingTsExtensions: true` to tsconfig.json

### 2. Missing Type Declarations (~10 errors)
- **Issue**: Missing types for `debug` module and some Polkadot modules
- **Solution**: Added `@types/debug` to devDependencies
- **Remaining**: Need to investigate Polkadot type imports

### 3. Implicit Any Types (~400 errors)
- **Issue**: Parameters and variables without type annotations
- **Categories**:
  - Event handler parameters
  - Array callback parameters
  - Function parameters
  - Catch block variables

### 4. Unsafe Operations (~150 errors)
- **Issue**: Operations on `any` typed values
- **Categories**:
  - Unsafe member access
  - Unsafe calls
  - Unsafe assignments

### 5. Strict Null Checks (~30 errors)
- **Issue**: Potential null/undefined values
- **Examples**:
  - Optional parameters passed as required
  - Variables used before assignment
  - Array access without bounds checking

### 6. Other Issues (~8 errors)
- Module resolution problems
- Index signature issues
- Type compatibility problems

## Fixing Strategy

### Phase 1: Quick Wins
1. Install missing type packages
2. Fix module import issues
3. Add basic type annotations for simple cases

### Phase 2: Systematic Fixes by Module
Fix errors module by module in order of importance:
1. **Core utilities** (`src/utils/`)
2. **Tools** (`src/tools/`) - one tool at a time
3. **Indexers** (`src/indexers/`)
4. **Lazy migrations** (`src/lazy-migrations/`)
5. **Hotfixes** (`src/hotfixes/`)
6. **State manipulators** (`src/libs/`)

### Phase 3: Complex Type Issues
1. Create proper interfaces for API responses
2. Fix unsafe any operations
3. Handle strict null checks properly

## Implementation Approach

### For Each Module:
1. Run `npx tsc --noEmit | grep "path/to/module"`
2. Fix all errors in that module
3. Test the module still works correctly
4. Commit changes for that module

### Type Annotation Guidelines:
- Prefer explicit types over `any`
- Use `unknown` instead of `any` when type is truly unknown
- Create interfaces for complex objects
- Use generics where appropriate
- Add JSDoc comments for complex types

## Tracking Progress
- Total errors: 748
- Errors fixed: 0
- Percentage complete: 0%

Update this document as errors are fixed to track progress.