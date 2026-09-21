export class MockGateway {
  describe() {
    return { adapter: 'mock', synthetic: true, operations: ['describe'] };
  }

  async submit() {
    throw new Error('NOT_IMPLEMENTED: the scaffold does not execute agent tasks');
  }

  async cancel() {
    throw new Error('NOT_IMPLEMENTED: the scaffold has no running agent tasks');
  }
}
